import pg from "pg";
import { createAuth } from "./auth";
import { makeBootstrapClient } from "./bootstrap";
import { loadEnv } from "./env";
import {
	ConsoleMailer,
	type Mailer,
	MemoryMailer,
	ResendMailer,
} from "./mail/mailer";

export const env = loadEnv();

export const pool = new pg.Pool({
	connectionString: env.DATABASE_URL,
	options: "-c search_path=auth",
});

/** Développement : copie des emails pour `/auth/dev/last-email`. */
export const devMailer =
	env.NODE_ENV === "development" ? new MemoryMailer() : undefined;

function makeMailer(): Mailer {
	if (env.NODE_ENV === "production") {
		// loadEnv garantit la présence de la clé en production.
		return new ResendMailer(env.RESEND_API_KEY ?? "", env.MAIL_FROM);
	}
	const consoleMailer = new ConsoleMailer();
	if (!devMailer) return consoleMailer;
	return {
		async send(msg) {
			await devMailer.send(msg);
			await consoleMailer.send(msg);
		},
	};
}

export const mailer = makeMailer();

export const auth = createAuth({
	pool,
	env,
	onUserCreated: makeBootstrapClient(
		env.API_INTERNAL_URL,
		env.INTERNAL_API_SECRET,
	),
});
