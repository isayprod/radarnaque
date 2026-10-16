import { getMigrations } from "better-auth/db/migration";
import type { Auth } from "./auth";

/** Crée ou met à jour les tables Better Auth dans le schéma `auth` (qui doit déjà exister). */
export async function runAuthMigrations(
	auth: Pick<Auth, "options">,
): Promise<void> {
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
}

// Exécution directe : `node --import tsx src/migrate.ts`.
if (import.meta.main) {
	const { auth, pool } = await import("./auth-instance");
	try {
		await runAuthMigrations(auth);
		console.info("[auth] migrations appliquées");
	} finally {
		await pool.end();
	}
}
