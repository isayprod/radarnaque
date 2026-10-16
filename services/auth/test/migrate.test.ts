import { decodeJwt, decodeProtectedHeader } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createAuth } from "../src/auth";
import { MemoryMailer } from "../src/mail/mailer";
import { runAuthMigrations } from "../src/migrate";
import { authPool, type StartedPg, startPg, testEnv } from "./helpers";

let db: StartedPg;
let pool: pg.Pool;

beforeAll(async () => {
	db = await startPg();
	pool = authPool(db.connectionString);
}, 120_000);

afterAll(async () => {
	await pool?.end();
	await db?.stop();
});

function otpFrom(mailer: MemoryMailer, to: string): string {
	const text = mailer.last(to)?.text ?? "";
	const match = text.match(/\b(\d{6})\b/);
	if (!match) throw new Error(`no 6-digit code in mail to ${to}: ${text}`);
	return match[1];
}

describe("auth migrations", () => {
	test("migrations create Better Auth tables in schema auth, with role column", async () => {
		const auth = createAuth({
			pool,
			env: testEnv({ DATABASE_URL: db.connectionString }),
			mailer: new MemoryMailer(),
			onUserCreated: async () => {},
		});
		await runAuthMigrations(auth);
		// Idempotent : un second passage ne doit rien casser.
		await runAuthMigrations(auth);

		const tables = await pool.query<{
			table_schema: string;
			table_name: string;
		}>(
			`SELECT table_schema, table_name FROM information_schema.tables
			 WHERE table_schema IN ('auth', 'public') ORDER BY table_name`,
		);
		const inAuth = tables.rows
			.filter((r) => r.table_schema === "auth")
			.map((r) => r.table_name);
		expect(inAuth).toEqual(
			expect.arrayContaining([
				"user",
				"session",
				"account",
				"verification",
				"jwks",
			]),
		);
		expect(tables.rows.filter((r) => r.table_schema === "public")).toEqual([]);

		const role = await pool.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = 'auth' AND table_name = 'user' AND column_name = 'role'`,
		);
		expect(role.rowCount).toBe(1);
	});
});

describe("createAuth", () => {
	test("sends a 6-digit OTP by email and notifies onUserCreated with the new user id", async () => {
		const mailer = new MemoryMailer();
		const created: string[] = [];
		const auth = createAuth({
			pool,
			env: testEnv({ DATABASE_URL: db.connectionString }),
			mailer,
			onUserCreated: async (id) => {
				created.push(id);
			},
		});
		await runAuthMigrations(auth);

		const email = "alice@example.test";
		await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
		const res = await auth.api.signInEmailOTP({
			body: { email, otp: otpFrom(mailer, email) },
		});

		expect(res.user.email).toBe(email);
		expect(created).toEqual([res.user.id]);
		const row = await pool.query(`SELECT role FROM "user" WHERE id = $1`, [
			res.user.id,
		]);
		expect(row.rows[0].role).toBe("user");
	});

	test("a failing onUserCreated is logged and never breaks sign-in", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const mailer = new MemoryMailer();
			const auth = createAuth({
				pool,
				env: testEnv({ DATABASE_URL: db.connectionString }),
				mailer,
				onUserCreated: async () => {
					throw new Error("api down");
				},
			});
			await runAuthMigrations(auth);

			const email = "bob@example.test";
			await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
			const res = await auth.api.signInEmailOTP({
				body: { email, otp: otpFrom(mailer, email) },
			});

			expect(res.user.email).toBe(email);
			expect(res.token).toBeTruthy();
			expect(errors).toHaveBeenCalled();
			expect(String(errors.mock.calls.flat().map(String))).toContain(
				res.user.id,
			);
		} finally {
			errors.mockRestore();
		}
	});

	test("issues an EdDSA JWT (15 min, iss=aud=PUBLIC_URL, sub=user id, empty payload) via bearer", async () => {
		const mailer = new MemoryMailer();
		const env = testEnv({ DATABASE_URL: db.connectionString });
		const auth = createAuth({
			pool,
			env,
			mailer,
			onUserCreated: async () => {},
		});
		await runAuthMigrations(auth);

		const email = "dave@example.test";
		await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
		const session = await auth.api.signInEmailOTP({
			body: { email, otp: otpFrom(mailer, email) },
		});
		const { token } = await auth.api.getToken({
			headers: new Headers({ authorization: `Bearer ${session.token}` }),
		});

		expect(decodeProtectedHeader(token).alg).toBe("EdDSA");
		const claims = decodeJwt(token);
		expect(claims.iss).toBe(env.PUBLIC_URL);
		expect(claims.aud).toBe(env.PUBLIC_URL);
		expect(claims.sub).toBe(session.user.id);
		expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(15 * 60);
		expect(Object.keys(claims).sort()).toEqual([
			"aud",
			"exp",
			"iat",
			"iss",
			"sub",
		]);
	});

	test("sends a magic link pointing at /auth/magic-link/verify", async () => {
		const mailer = new MemoryMailer();
		const auth = createAuth({
			pool,
			env: testEnv({ DATABASE_URL: db.connectionString }),
			mailer,
			onUserCreated: async () => {},
		});
		await runAuthMigrations(auth);

		const email = "carol@example.test";
		await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
		expect(mailer.last(email)?.text).toContain(
			"http://localhost:8080/auth/magic-link/verify?token=",
		);
	});
});
