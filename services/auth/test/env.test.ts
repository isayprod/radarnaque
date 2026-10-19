import { describe, expect, test } from "vitest";
import { loadEnv } from "../src/env";

const valid = {
	NODE_ENV: "development",
	PUBLIC_URL: "http://localhost:8080",
	BETTER_AUTH_SECRET: "x".repeat(32),
	DATABASE_URL: "postgres://u:p@localhost:5432/db",
	EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
	API_INTERNAL_URL: "http://localhost:8000",
	INTERNAL_API_SECRET: "i".repeat(32),
	MAIL_FROM: "Radarnaque <no-reply@example.test>",
};

describe("loadEnv", () => {
	test("parses a valid environment", () => {
		const env = loadEnv(valid);
		expect(env.PUBLIC_URL).toBe("http://localhost:8080");
		expect(env.EXTENSION_ID).toBe(valid.EXTENSION_ID);
		expect(env.NODE_ENV).toBe("development");
		expect(env.RESEND_API_KEY).toBeUndefined();
	});

	test("loadEnv rejects a short secret and an invalid EXTENSION_ID", () => {
		expect(() =>
			loadEnv({ ...valid, BETTER_AUTH_SECRET: "x".repeat(31) }),
		).toThrow(/BETTER_AUTH_SECRET/);
		expect(() =>
			loadEnv({ ...valid, EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnoq" }),
		).toThrow(/EXTENSION_ID/);
		expect(() =>
			loadEnv({ ...valid, EXTENSION_ID: "abcdefghijklmnop" }),
		).toThrow(/EXTENSION_ID/);
	});

	test("INTERNAL_API_SECRET must be at least 32 characters", () => {
		expect(() =>
			loadEnv({ ...valid, INTERNAL_API_SECRET: "i".repeat(31) }),
		).toThrow(/INTERNAL_API_SECRET/);
		expect(loadEnv(valid).INTERNAL_API_SECRET).toBe("i".repeat(32));
	});

	test("names the missing variable", () => {
		for (const key of Object.keys(valid)) {
			const source: Record<string, string | undefined> = { ...valid };
			delete source[key];
			expect(() => loadEnv(source)).toThrow(new RegExp(key));
		}
	});

	test("rejects an invalid NODE_ENV and a non-URL PUBLIC_URL", () => {
		expect(() => loadEnv({ ...valid, NODE_ENV: "staging" })).toThrow(
			/NODE_ENV/,
		);
		expect(() => loadEnv({ ...valid, PUBLIC_URL: "not a url" })).toThrow(
			/PUBLIC_URL/,
		);
	});

	test("PUBLIC_URL must be a bare origin (it is the JWT iss/aud and a trusted origin)", () => {
		for (const bad of [
			"http://localhost:8080/",
			"https://x.test/auth",
			"ftp://x.test",
		]) {
			expect(() => loadEnv({ ...valid, PUBLIC_URL: bad })).toThrow(
				/PUBLIC_URL/,
			);
		}
		expect(
			loadEnv({ ...valid, PUBLIC_URL: "https://radarnaque.mostconsult.be" })
				.PUBLIC_URL,
		).toBe("https://radarnaque.mostconsult.be");
	});

	test("requires RESEND_API_KEY in production only", () => {
		expect(() => loadEnv({ ...valid, NODE_ENV: "production" })).toThrow(
			/RESEND_API_KEY/,
		);
		expect(
			loadEnv({ ...valid, NODE_ENV: "production", RESEND_API_KEY: "re_x" })
				.RESEND_API_KEY,
		).toBe("re_x");
	});

	test("rejects change-me placeholder secrets in production only, naming the variable", () => {
		const prod = { ...valid, NODE_ENV: "production", RESEND_API_KEY: "re_x" };
		for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_API_SECRET"]) {
			for (const placeholder of [
				"change-me-with-at-least-32-random-characters",
				"CHANGE-ME-with-at-least-32-random-characters",
			]) {
				expect(() => loadEnv({ ...prod, [name]: placeholder })).toThrow(
					new RegExp(`${name}.*change-me`),
				);
				// En dev et en test, la valeur d'exemple reste utilisable.
				expect(() => loadEnv({ ...valid, [name]: placeholder })).not.toThrow();
			}
		}
		expect(loadEnv(prod).NODE_ENV).toBe("production");
	});

	test("rejects a change-me Postgres password in DATABASE_URL in production only", () => {
		const prod = { ...valid, NODE_ENV: "production", RESEND_API_KEY: "re_x" };
		const url =
			"postgres://radarnaque:change-me-postgres-password@postgres:5432/radarnaque";
		expect(() => loadEnv({ ...prod, DATABASE_URL: url })).toThrow(
			/DATABASE_URL.*change-me/,
		);
		expect(loadEnv({ ...valid, DATABASE_URL: url }).DATABASE_URL).toBe(url);
	});

	test("DEV_SUPERUSER_EMAIL is optional, trimmed and lowercased; empty means absent", () => {
		expect(loadEnv(valid).DEV_SUPERUSER_EMAIL).toBeUndefined();
		for (const empty of ["", "   "]) {
			expect(
				loadEnv({ ...valid, DEV_SUPERUSER_EMAIL: empty }).DEV_SUPERUSER_EMAIL,
			).toBeUndefined();
		}
		expect(
			loadEnv({ ...valid, DEV_SUPERUSER_EMAIL: "  SuperUser@Radarnaque.TEST " })
				.DEV_SUPERUSER_EMAIL,
		).toBe("superuser@radarnaque.test");
	});

	test("rejects an invalid DEV_SUPERUSER_EMAIL without echoing it", () => {
		expect(() =>
			loadEnv({ ...valid, DEV_SUPERUSER_EMAIL: "pas-un-email" }),
		).toThrow(/DEV_SUPERUSER_EMAIL/);
		expect(() =>
			loadEnv({ ...valid, DEV_SUPERUSER_EMAIL: "pas-un-email" }),
		).not.toThrow(/pas-un-email/);
	});
});
