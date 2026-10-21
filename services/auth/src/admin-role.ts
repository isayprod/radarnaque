import type { Pool } from "pg";
import { isEmail, normalizeEmail } from "./env";
import { maskEmail } from "./superuser";

/** Codes de sortie de `pnpm admin:grant` et `pnpm admin:revoke`. */
export const ADMIN_EXIT = {
	ok: 0,
	notFound: 1,
	lastAdmin: 3,
	usage: 64,
} as const;

const USAGE = "usage : pnpm admin:grant <email> | pnpm admin:revoke <email>";

/** Donne le rôle admin au compte de cet email ; `false` si aucun compte ne le porte. */
async function grantAdmin(pool: Pool, email: string): Promise<boolean> {
	// Better Auth enregistre les emails en minuscules ; `lower()` couvre un compte plus ancien.
	const res = await pool.query(
		`UPDATE "user" SET role = 'admin', "updatedAt" = now() WHERE lower(email) = $1`,
		[email],
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Retire le rôle admin du compte de cet email. Les admins sont verrouillés (`FOR UPDATE`,
 * toujours dans le même ordre) pour que deux retraits simultanés ne suppriment pas le
 * dernier admin : le second attend le premier, puis relit la liste à jour.
 */
async function revokeAdmin(
	pool: Pool,
	email: string,
): Promise<"revoked" | "notAdmin" | "notFound" | "lastAdmin"> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const admins = await client.query<{ id: string; email: string }>(
			`SELECT id, email FROM "user" WHERE role = 'admin' ORDER BY id FOR UPDATE`,
		);
		const target = admins.rows.find((row) => row.email.toLowerCase() === email);
		if (!target) {
			await client.query("ROLLBACK");
			const exists = await pool.query(
				`SELECT 1 FROM "user" WHERE lower(email) = $1`,
				[email],
			);
			return (exists.rowCount ?? 0) > 0 ? "notAdmin" : "notFound";
		}
		if (admins.rows.length === 1) {
			await client.query("ROLLBACK");
			return "lastAdmin";
		}
		await client.query(
			`UPDATE "user" SET role = 'user', "updatedAt" = now() WHERE id = $1`,
			[target.id],
		);
		await client.query("COMMIT");
		return "revoked";
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

/**
 * `pnpm admin:grant <email>` et `pnpm admin:revoke <email>` : donne ou retire le rôle admin
 * d'un compte existant. Autorisée en production (c'est la seule façon de créer un admin) ;
 * ne crée jamais de compte (code 1 si introuvable) et refuse de retirer le dernier admin
 * (code 3). N'affiche ni DATABASE_URL ni l'email en clair.
 */
export async function adminRoleCommand(
	args: string[],
	source: Record<string, string | undefined>,
	makePool: (databaseUrl: string) => Pool,
): Promise<number> {
	const verb = args[0];
	const email = normalizeEmail(args[1]);
	if (
		(verb !== "grant" && verb !== "revoke") ||
		!email ||
		!isEmail(email) ||
		args.length > 2
	) {
		console.error(`[admin] ${USAGE}`);
		return ADMIN_EXIT.usage;
	}
	const tag = `[admin:${verb}]`;

	const databaseUrl = source.DATABASE_URL?.trim();
	if (!databaseUrl) {
		console.error(`${tag} DATABASE_URL manquante (infra/.env)`);
		return ADMIN_EXIT.usage;
	}

	const masked = maskEmail(email);
	const pool = makePool(databaseUrl);
	try {
		if (verb === "grant") {
			if (!(await grantAdmin(pool, email))) {
				console.error(
					`${tag} aucun compte pour ${masked} : se connecter une première fois depuis l'extension ou le site`,
				);
				return ADMIN_EXIT.notFound;
			}
			console.info(`${tag} ${masked} est maintenant admin`);
			return ADMIN_EXIT.ok;
		}

		const result = await revokeAdmin(pool, email);
		if (result === "notFound") {
			console.error(`${tag} aucun compte pour ${masked}`);
			return ADMIN_EXIT.notFound;
		}
		if (result === "lastAdmin") {
			console.error(
				`${tag} refusé : ${masked} est le dernier admin (en désigner un autre d'abord)`,
			);
			return ADMIN_EXIT.lastAdmin;
		}
		console.info(
			result === "revoked"
				? `${tag} ${masked} n'est plus admin`
				: `${tag} ${masked} n'est pas admin : rien à retirer`,
		);
		return ADMIN_EXIT.ok;
	} finally {
		await pool.end();
	}
}
