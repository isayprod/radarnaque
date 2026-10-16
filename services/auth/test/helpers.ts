import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { vi } from "vitest";
import type { Auth } from "../src/auth";
import type { Env } from "../src/env";
import { runAuthMigrations } from "../src/migrate";

export type StartedPg = { connectionString: string; stop: () => Promise<void> };

/** Démarre un Postgres 17 jetable avec les schémas `auth` et `app` créés. */
export async function startPg(): Promise<StartedPg> {
	const container = await new PostgreSqlContainer("postgres:17").start();
	const connectionString = container.getConnectionUri();
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await client.query(
			"CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS app;",
		);
	} finally {
		await client.end();
	}
	return {
		connectionString,
		stop: async () => {
			await container.stop();
		},
	};
}

/** Environnement valide pour les tests, surchargeable champ par champ. */
export function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		NODE_ENV: "test",
		PUBLIC_URL: "http://localhost:8080",
		BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters!!",
		DATABASE_URL: "postgres://radarnaque:radarnaque@localhost:5432/radarnaque",
		EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
		API_INTERNAL_URL: "http://localhost:8000",
		INTERNAL_API_SECRET: "test-internal-secret-with-32-chars-min",
		MAIL_FROM: "Radarnaque <no-reply@radarnaque.test>",
		RESEND_API_KEY: undefined,
		...overrides,
	};
}

/** Pool `pg` sur le schéma `auth`, comme en production. */
export function authPool(connectionString: string): pg.Pool {
	return new pg.Pool({ connectionString, options: "-c search_path=auth" });
}

/**
 * Migre une base vierge sans bruit : une instance créée avant ses tables journalise une
 * fois « Database schema mismatch » (contrôle lancé à l'initialisation). Les appels
 * concurrents de `checkSchema` partagent la même promesse : on l'attend sous un console.error
 * muet, puis on migre (ce qui invalide le contrôle pour les requêtes suivantes).
 */
export async function migrateFresh(auth: Auth): Promise<void> {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const ctx = (await auth.$context) as {
			checkSchema?: () => Promise<unknown>;
		};
		await ctx.checkSchema?.().catch(() => {});
		await runAuthMigrations(auth);
	} finally {
		errors.mockRestore();
	}
}
