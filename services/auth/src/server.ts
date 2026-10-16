import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { auth, devMailer, env, mailer, pool } from "./auth-instance";
import { runAuthMigrations } from "./migrate";

const PORT = 3000;

if (process.env.AUTH_MIGRATE_ON_START === "1") {
	await runAuthMigrations(auth);
	console.info("[auth] migrations appliquées");
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
