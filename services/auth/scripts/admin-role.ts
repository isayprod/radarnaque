/**
 * `pnpm admin:grant <email>` et `pnpm admin:revoke <email>` (depuis la racine) : donne ou
 * retire le rôle admin d'un compte existant. Lit infra/.env (--env-file) ; autorisé en production.
 */
import pg from "pg";
import { adminRoleCommand } from "../src/admin-role";

process.exitCode = await adminRoleCommand(
	process.argv.slice(2),
	process.env,
	(connectionString) =>
		new pg.Pool({ connectionString, options: "-c search_path=auth" }),
);
