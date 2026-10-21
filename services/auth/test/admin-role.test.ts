import type pg from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { ADMIN_EXIT, adminRoleCommand } from "../src/admin-role";
import type { Auth } from "../src/auth";
import { createAuth } from "../src/auth";
import {
	authPool,
	captureSignIn,
	migrateFresh,
	type StartedPg,
	startPg,
	testEnv,
} from "./helpers";

const ALICE = "alice-admin@radarnaque.test";
const BOB = "bob-admin@radarnaque.test";

let db: StartedPg;
let pool: pg.Pool;

beforeAll(async () => {
	db = await startPg();
	pool = authPool(db.connectionString);
	await migrateFresh(makeAuth());
}, 120_000);

afterAll(async () => {
	await pool?.end();
	await db?.stop();
});

// Chaque test part d'une base sans aucun compte : « dernier admin » en dépend.
beforeEach(async () => {
	await pool.query(`DELETE FROM "user"`);
});

function makeAuth(): Auth {
	return createAuth({
		pool,
		env: testEnv({ DATABASE_URL: db.connectionString }),
		onUserCreated: async () => {},
	});
}

/** Inscription par code, comme un utilisateur réel. */
async function signUp(email: string) {
	const auth = makeAuth();
	const { otp } = await captureSignIn(() =>
		auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } }),
	);
	if (!otp) throw new Error(`pas de code pour ${email}`);
	await auth.api.signInEmailOTP({ body: { email, otp } });
}

async function roleOf(email: string): Promise<string | undefined> {
	const res = await pool.query<{ role: string }>(
		`SELECT role FROM "user" WHERE email = $1`,
		[email],
	);
	return res.rows[0]?.role;
}

/** Fait taire la console pendant `fn` et renvoie tout ce qui a été journalisé. */
async function quietly<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; logs: string }> {
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const result = await fn();
		const logs = [info, warn, error]
			.flatMap((spy) => spy.mock.calls.flat())
			.map(String)
			.join("\n");
		return { result, logs };
	} finally {
		info.mockRestore();
		warn.mockRestore();
		error.mockRestore();
	}
}

const run = (
	args: string[],
	source: Record<string, string | undefined> = {
		NODE_ENV: "production",
		DATABASE_URL: db.connectionString,
	},
) => quietly(() => adminRoleCommand(args, source, (url) => authPool(url)));

describe("admin:grant et admin:revoke", () => {
	test("admin:grant promotes, admin:revoke demotes", async () => {
		await signUp(ALICE);
		await signUp(BOB);

		const grant = await run(["grant", ALICE]);
		expect(grant.result).toBe(ADMIN_EXIT.ok);
		expect(await roleOf(ALICE)).toBe("admin");
		expect(await roleOf(BOB)).toBe("user");

		// Un second admin existe : le premier peut être rétrogradé.
		await run(["grant", BOB]);
		const revoke = await run(["revoke", ALICE]);
		expect(revoke.result).toBe(ADMIN_EXIT.ok);
		expect(await roleOf(ALICE)).toBe("user");
		expect(await roleOf(BOB)).toBe("admin");
	});

	test("fonctionne en production (NODE_ENV=production)", async () => {
		await signUp(ALICE);
		const { result } = await run(["grant", ALICE], {
			NODE_ENV: "production",
			ENV: "production",
			DATABASE_URL: db.connectionString,
		});
		expect(result).toBe(0);
		expect(await roleOf(ALICE)).toBe("admin");
	});

	test("normalise l'email (espaces, majuscules) et accorde un rôle NULL ou superuser", async () => {
		await signUp(ALICE);
		await pool.query(`UPDATE "user" SET role = 'superuser' WHERE email = $1`, [
			ALICE,
		]);
		const { result } = await run(["grant", "  Alice-Admin@Radarnaque.TEST "]);
		expect(result).toBe(0);
		expect(await roleOf(ALICE)).toBe("admin");
	});

	test("grant est idempotent", async () => {
		await signUp(ALICE);
		expect((await run(["grant", ALICE])).result).toBe(0);
		expect((await run(["grant", ALICE])).result).toBe(0);
		expect(await roleOf(ALICE)).toBe("admin");
	});

	test("grant d'un email inconnu → 1, sans créer de compte", async () => {
		const { result } = await run(["grant", ALICE]);
		expect(result).toBe(ADMIN_EXIT.notFound);
		const count = await pool.query(`SELECT 1 FROM "user"`);
		expect(count.rowCount).toBe(0);
	});

	test("revoke d'un email inconnu → 1", async () => {
		await signUp(BOB);
		await run(["grant", BOB]);
		expect((await run(["revoke", ALICE])).result).toBe(ADMIN_EXIT.notFound);
		expect(await roleOf(BOB)).toBe("admin");
	});

	test("revoke du dernier admin → 3 et le rôle reste", async () => {
		await signUp(ALICE);
		await run(["grant", ALICE]);
		const { result, logs } = await run(["revoke", ALICE]);
		expect(result).toBe(ADMIN_EXIT.lastAdmin);
		expect(await roleOf(ALICE)).toBe("admin");
		expect(logs).toContain("dernier admin");
	});

	test("revoke d'un compte qui n'est pas admin → 0, sans effet", async () => {
		await signUp(ALICE);
		await signUp(BOB);
		await run(["grant", BOB]);
		const { result } = await run(["revoke", ALICE]);
		expect(result).toBe(0);
		expect(await roleOf(ALICE)).toBe("user");
		expect(await roleOf(BOB)).toBe("admin");
	});

	test("deux revoke simultanés : un admin reste", async () => {
		await signUp(ALICE);
		await signUp(BOB);
		await run(["grant", ALICE]);
		await run(["grant", BOB]);
		const [a, b] = await Promise.all([
			run(["revoke", ALICE]),
			run(["revoke", BOB]),
		]);
		expect([a.result, b.result].sort()).toEqual([0, ADMIN_EXIT.lastAdmin]);
		const admins = await pool.query(
			`SELECT 1 FROM "user" WHERE role = 'admin'`,
		);
		expect(admins.rowCount).toBe(1);
	});

	test("usage invalide → 64, sans ouvrir de connexion", async () => {
		const makePool = vi.fn((url: string) => authPool(url));
		const source = {
			NODE_ENV: "production",
			DATABASE_URL: db.connectionString,
		};
		for (const args of [
			[],
			["grant"],
			["promote", ALICE],
			["grant", "pas-un-email"],
			["grant", ALICE, BOB],
		]) {
			const { result } = await quietly(() =>
				adminRoleCommand(args, source, makePool),
			);
			expect(result, JSON.stringify(args)).toBe(ADMIN_EXIT.usage);
		}
		const noUrl = await quietly(() =>
			adminRoleCommand(["grant", ALICE], { NODE_ENV: "production" }, makePool),
		);
		expect(noUrl.result).toBe(ADMIN_EXIT.usage);
		expect(makePool).not.toHaveBeenCalled();
	});

	test("les logs ne contiennent ni l'email complet ni DATABASE_URL", async () => {
		await signUp(ALICE);
		await signUp(BOB);
		const outputs = [
			await run(["grant", ALICE]),
			await run(["grant", BOB]),
			await run(["revoke", ALICE]),
			await run(["revoke", BOB]),
			await run(["grant", "inconnu@radarnaque.test"]),
			await run(["grant", "pas-un-email"]),
		];
		const logs = outputs.map((o) => o.logs).join("\n");
		expect(logs).not.toContain(ALICE);
		expect(logs).not.toContain(BOB);
		expect(logs).not.toContain("inconnu@radarnaque.test");
		expect(logs).not.toContain(db.connectionString);
		expect(logs).toContain("al***@radarnaque.test");
	});
});
