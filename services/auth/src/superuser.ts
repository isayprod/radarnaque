import type { Pool } from "pg";
import type { Auth } from "./auth";
import { type Env, isEmail, type NodeEnv, normalizeEmail } from "./env";

/**
 * Rôle de développement (spec §5.3 bis) : quota illimité et bloc `debug` côté API, hors
 * production uniquement. Ce n'est pas un rôle d'administration : il ne figure pas dans
 * `adminRoles` du plugin admin et n'y donne aucune permission.
 */
export const SUPERUSER_ROLE = "superuser";

/** `superuser@radarnaque.test` → `su***@radarnaque.test` : jamais d'email complet dans un log. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf("@");
	const local = at >= 0 ? email.slice(0, at) : email;
	const domain = at >= 0 ? email.slice(at) : "";
	// Partie locale d'un caractère (ou vide) : rien n'en est montré.
	if (local.length <= 1) return `*${domain}`;
	// Au moins un caractère masqué : « ab » ne laisse voir que « a ».
	const kept = local.slice(0, Math.min(2, local.length - 1));
	return `${kept}***${domain}`;
}

/** Vrai si `email` est le compte DEV_SUPERUSER_EMAIL et que l'on n'est pas en production. */
export function isDevSuperuserEmail(
	email: string | null | undefined,
	env: Pick<Env, "NODE_ENV" | "DEV_SUPERUSER_EMAIL">,
): boolean {
	if (env.NODE_ENV === "production" || !env.DEV_SUPERUSER_EMAIL) return false;
	return normalizeEmail(email ?? undefined) === env.DEV_SUPERUSER_EMAIL;
}

export type PromoteResult = "promoted" | "admin" | "notFound";

/**
 * Donne le rôle superuser au compte de cet email. Un compte admin n'est jamais
 * rétrogradé : il garde son rôle (`"admin"`, avec une ligne de log masquée).
 * `"notFound"` si aucun compte ne porte cet email.
 */
export async function promoteSuperuser(
	pool: Pool,
	email: string,
): Promise<PromoteResult> {
	const lower = email.toLowerCase();
	// Better Auth enregistre les emails en minuscules ; `lower()` couvre un compte plus ancien.
	// `IS DISTINCT FROM` : un rôle NULL (compte antérieur au plugin admin) est promu aussi.
	const res = await pool.query(
		`UPDATE "user" SET role = $1, "updatedAt" = now()
		 WHERE lower(email) = $2 AND role IS DISTINCT FROM 'admin'`,
		[SUPERUSER_ROLE, lower],
	);
	if ((res.rowCount ?? 0) > 0) return "promoted";
	const admin = await pool.query(
		`SELECT 1 FROM "user" WHERE lower(email) = $1 AND role = 'admin'`,
		[lower],
	);
	if ((admin.rowCount ?? 0) === 0) return "notFound";
	console.warn(
		`[auth] ${maskEmail(email)} est admin : rôle laissé inchangé (pas de superuser)`,
	);
	return "admin";
}

export type EnsureDevSuperuserResult =
	| "disabled"
	| "promoted"
	| "created"
	| "admin";

/**
 * Appelé au démarrage du service auth, après les migrations : donne le rôle superuser au
 * compte DEV_SUPERUSER_EMAIL, ou le crée s'il n'existe pas. Hors production uniquement.
 *
 * La création passe par `internalAdapter.createUser`, comme l'inscription par code : mêmes
 * hooks (rôle par défaut du plugin admin, puis `databaseHooks.user.create`), donc même
 * bootstrap de l'essai côté API. Ce bootstrap échoue si l'API n'est pas encore démarrée :
 * le hook le journalise sans le propager, et `GET /api/me` rattrape l'essai manquant.
 */
export async function ensureDevSuperuser(
	{ auth, pool }: { auth: Pick<Auth, "$context">; pool: Pool },
	rawEmail: string | undefined,
	nodeEnv: NodeEnv,
): Promise<EnsureDevSuperuserResult> {
	const email = normalizeEmail(rawEmail);
	if (!email) return "disabled";
	if (nodeEnv === "production") {
		// Pas d'email dans ce message, même masqué : le log de production est durable.
		console.warn(
			"[auth] DEV_SUPERUSER_EMAIL est ignoré en production : aucun rôle superuser attribué",
		);
		return "disabled";
	}

	const promoted = await promoteSuperuser(pool, email);
	// Compte admin : laissé tel quel, la ligne de log vient de `promoteSuperuser`.
	if (promoted === "admin") return "admin";
	let result: EnsureDevSuperuserResult = "promoted";
	if (promoted === "notFound") {
		const ctx = await auth.$context;
		await ctx.internalAdapter.createUser(
			{ email, name: "", emailVerified: true, role: SUPERUSER_ROLE },
			{ method: "admin" },
		);
		result = "created";
	}
	console.info(`[auth] superuser de dev : ${maskEmail(email)}`);
	return result;
}

/** Codes de sortie de `pnpm dev:superuser`. */
export const EXIT = {
	ok: 0,
	notFound: 1,
	production: 2,
	admin: 3,
	usage: 64,
} as const;

/**
 * `pnpm dev:superuser <email>` : donne le rôle superuser à un compte existant. Refuse en
 * production (NODE_ENV ou ENV, code 2) avant toute connexion, ne crée jamais de compte
 * (code 1 si introuvable) et ne rétrograde jamais un admin (code 3). N'affiche ni DATABASE_URL ni l'email en clair.
 */
export async function devSuperuserCommand(
	args: string[],
	source: Record<string, string | undefined>,
	makePool: (databaseUrl: string) => Pool,
): Promise<number> {
	if (
		source.NODE_ENV?.trim() === "production" ||
		source.ENV?.trim() === "production"
	) {
		console.error(
			"[dev:superuser] refusé : le rôle superuser n'existe pas en production",
		);
		return EXIT.production;
	}

	const email = normalizeEmail(args[0]);
	if (!email || !isEmail(email) || args.length > 1) {
		console.error("[dev:superuser] usage : pnpm dev:superuser <email>");
		return EXIT.usage;
	}

	const databaseUrl = source.DATABASE_URL?.trim();
	if (!databaseUrl) {
		console.error("[dev:superuser] DATABASE_URL manquante (infra/.env)");
		return EXIT.usage;
	}

	const pool = makePool(databaseUrl);
	try {
		const promoted = await promoteSuperuser(pool, email);
		// Compte admin : jamais rétrogradé, la ligne de log vient de `promoteSuperuser`.
		if (promoted === "admin") return EXIT.admin;
		if (promoted === "notFound") {
			console.error(
				`[dev:superuser] aucun compte pour ${maskEmail(email)} : se connecter une première fois depuis l'extension ou le site`,
			);
			return EXIT.notFound;
		}
		console.info(
			`[dev:superuser] ${maskEmail(email)} a maintenant le rôle superuser`,
		);
		return EXIT.ok;
	} finally {
		await pool.end();
	}
}
