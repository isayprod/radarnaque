import pg from "pg";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { ConsoleMailer, type Mailer, ResendMailer } from "./mail/mailer";

export const env = loadEnv();

export const pool = new pg.Pool({
	connectionString: env.DATABASE_URL,
	options: "-c search_path=auth",
});

export const mailer: Mailer = env.RESEND_API_KEY
	? new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM)
	: new ConsoleMailer();

export const auth = createAuth({
	pool,
	env,
	mailer,
	// TODO(tâche 8) : appel du bootstrap de l'API (POST interne avec X-Internal-Secret).
	onUserCreated: async () => {},
});
