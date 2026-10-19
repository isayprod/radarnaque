/**
 * `pnpm dev:superuser <email>` (depuis la racine) : donne le rôle superuser à un compte
 * existant de la base de dev. Lit infra/.env (--env-file) ; refuse en production.
 */
import pg from "pg";
import { devSuperuserCommand } from "../src/superuser";

process.exitCode = await devSuperuserCommand(
	process.argv.slice(2),
	process.env,
	(connectionString) =>
		new pg.Pool({ connectionString, options: "-c search_path=auth" }),
);
