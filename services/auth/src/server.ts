import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { auth, devMailer, env, mailer, pool } from "./auth-instance";
import { runAuthMigrations } from "./migrate";
import { ensureDevSuperuser } from "./superuser";

const PORT = 3000;

if (process.env.AUTH_MIGRATE_ON_START === "1") {
	await runAuthMigrations(auth);
	console.info("[auth] migrations appliquées");
}

// Superuser de développement (§5.3 bis). Un échec (tables absentes, base indisponible…)
// est journalisé sans email et n'empêche pas le service de démarrer.
try {
	await ensureDevSuperuser(
		{ auth, pool },
		env.DEV_SUPERUSER_EMAIL,
		env.NODE_ENV,
	);
} catch (error) {
	console.error(
		"[auth] superuser de dev non attribué :",
		error instanceof Error ? error.message : error,
	);
}

const app = createApp({ auth, mailer, env, devMailer });

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
	console.info(`[auth] à l'écoute sur le port ${info.port} (${env.NODE_ENV})`);
});

function shutdown() {
	server.close(() => {
		void pool.end().finally(() => process.exit(0));
	});
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
