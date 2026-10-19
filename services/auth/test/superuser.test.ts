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
import type { Auth } from "../src/auth";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import {
	devSuperuserCommand,
	ensureDevSuperuser,
	maskEmail,
	SUPERUSER_ROLE,
} from "../src/superuser";
import {
	authPool,
	captureSignIn,
	migrateFresh,
	type StartedPg,
	startPg,
	testEnv,
} from "./helpers";

const SUPERUSER = "superuser@radarnaque.test";
const OTHER = "ordinaire@radarnaque.test";

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

// Chaque test part d'une base sans ces deux comptes (sessions et comptes suivent en cascade).
beforeEach(async () => {
	await pool.query(`DELETE FROM "user" WHERE email = ANY($1)`, [
		[SUPERUSER, OTHER],
	]);
});

function makeAuth(
	overrides: Partial<Env> = {},
	onUserCreated: (id: string) => Promise<void> = async () => {},
): Auth {
	return createAuth({
		pool,
		env: testEnv({ DATABASE_URL: db.connectionString, ...overrides }),
		onUserCreated,
	});
}

/** Inscription par code, comme un utilisateur réel (crée le compte s'il n'existe pas). */
async function signUp(auth: Auth, email: string) {
	const { otp } = await captureSignIn(() =>
		auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } }),
	);
	if (!otp) throw new Error(`pas de code pour ${email}`);
	return auth.api.signInEmailOTP({ body: { email, otp } });
}

async function roleOf(email: string): Promise<string | undefined> {
	const res = await pool.query<{ role: string }>(
		`SELECT role FROM "user" WHERE email = $1`,
		[email],
	);
	return res.rows[0]?.role;
}

async function countUsers(email: string): Promise<number> {
	const res = await pool.query(`SELECT 1 FROM "user" WHERE email = $1`, [
		email,
	]);
	return res.rowCount ?? 0;
}

/** Fait taire console.info / console.warn pendant `fn` et renvoie tout ce qui a été journalisé. */
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

describe("maskEmail", () => {
	test("masque la partie locale et garde le domaine", () => {
		expect(maskEmail("superuser@radarnaque.test")).toBe(
			"su***@radarnaque.test",
		);
		expect(maskEmail("ab@x.test")).toBe("a***@x.test");
		expect(maskEmail("a@x.test")).toBe("a***@x.test");
	});
});

describe("ensureDevSuperuser", () => {
	test("promeut un compte existant, sans journaliser l'email en clair", async () => {
		const auth = makeAuth();
		await signUp(auth, SUPERUSER);
		expect(await roleOf(SUPERUSER)).toBe("user");

		const { result, logs } = await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "development"),
		);

		expect(result).toBe("promoted");
		expect(await roleOf(SUPERUSER)).toBe(SUPERUSER_ROLE);
		expect(logs).toContain("superuser de dev : su***@radarnaque.test");
		expect(logs).not.toContain(SUPERUSER);
	});

	test("crée un compte absent avec le rôle, par le chemin d'inscription (bootstrap appelé)", async () => {
		const created: string[] = [];
		const auth = makeAuth({}, async (id) => {
			created.push(id);
		});

		const { result } = await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "development"),
		);

		expect(result).toBe("created");
		const row = await pool.query<{
			id: string;
			role: string;
			emailVerified: boolean;
		}>(`SELECT id, role, "emailVerified" FROM "user" WHERE email = $1`, [
			SUPERUSER,
		]);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].role).toBe(SUPERUSER_ROLE);
		expect(row.rows[0].emailVerified).toBe(true);
		expect(created).toEqual([row.rows[0].id]);
	});

	test("un bootstrap en échec (API éteinte) ne fait pas échouer la création", async () => {
		const auth = makeAuth({}, async () => {
			throw new Error("api down");
		});

		const { result } = await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "development"),
		);

		expect(result).toBe("created");
		expect(await roleOf(SUPERUSER)).toBe(SUPERUSER_ROLE);
	});

	test("est idempotent : un second appel laisse un seul compte superuser", async () => {
		const auth = makeAuth();
		await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "development"),
		);
		const { result } = await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "development"),
		);

		expect(result).toBe("promoted");
		expect(await countUsers(SUPERUSER)).toBe(1);
		expect(await roleOf(SUPERUSER)).toBe(SUPERUSER_ROLE);
	});

	test("en production, ne fait rien et avertit sans citer l'email", async () => {
		const auth = makeAuth();
		await signUp(auth, SUPERUSER);

		const { result, logs } = await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "production"),
		);

		expect(result).toBe("disabled");
		expect(await roleOf(SUPERUSER)).toBe("user");
		expect(logs).toMatch(/DEV_SUPERUSER_EMAIL/);
		expect(logs).not.toContain(SUPERUSER);
		expect(logs).not.toContain("su***");
	});

	test("en production, un compte absent n'est pas créé", async () => {
		const auth = makeAuth();
		await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "production"),
		);
		expect(await countUsers(SUPERUSER)).toBe(0);
	});

	test("sans email (absent ou vide), ne fait rien et ne journalise rien", async () => {
		const auth = makeAuth();
		for (const email of [undefined, "", "   "]) {
			const { result, logs } = await quietly(() =>
				ensureDevSuperuser({ auth, pool }, email, "development"),
			);
			expect(result).toBe("disabled");
			expect(logs).toBe("");
		}
		expect(await countUsers(SUPERUSER)).toBe(0);
	});
});

describe("hook de création d'utilisateur", () => {
	test("l'inscription de DEV_SUPERUSER_EMAIL pose le rôle superuser", async () => {
		const auth = makeAuth({
			NODE_ENV: "development",
			DEV_SUPERUSER_EMAIL: SUPERUSER,
		});
		const res = await signUp(auth, SUPERUSER);
		expect(res.user.email).toBe(SUPERUSER);
		expect(await roleOf(SUPERUSER)).toBe(SUPERUSER_ROLE);
	});

	test("les autres emails restent user", async () => {
		const auth = makeAuth({
			NODE_ENV: "development",
			DEV_SUPERUSER_EMAIL: SUPERUSER,
		});
		await signUp(auth, OTHER);
		expect(await roleOf(OTHER)).toBe("user");
	});

	test("en production, le hook ne pose jamais le rôle", async () => {
		const auth = makeAuth({
			NODE_ENV: "production",
			DEV_SUPERUSER_EMAIL: SUPERUSER,
		});
		await signUp(auth, SUPERUSER);
		expect(await roleOf(SUPERUSER)).toBe("user");
	});
});

describe("plugin admin", () => {
	test("les routes admin acceptent un compte superuser, qui n'est pas admin pour autant", async () => {
		const auth = makeAuth();
		const admin = await signUp(auth, OTHER);
		await pool.query(`UPDATE "user" SET role = 'admin' WHERE id = $1`, [
			admin.user.id,
		]);
		await quietly(() =>
			ensureDevSuperuser({ auth, pool }, SUPERUSER, "development"),
		);

		const listed = await auth.api.listUsers({
			query: { searchField: "email", searchValue: SUPERUSER },
			headers: new Headers({ authorization: `Bearer ${admin.token}` }),
		});
		expect(listed.users.map((u) => [u.email, u.role])).toEqual([
			[SUPERUSER, SUPERUSER_ROLE],
		]);

		// Un superuser n'a aucun droit d'administration.
		const su = await signUp(auth, SUPERUSER);
		await expect(
			auth.api.listUsers({
				query: {},
				headers: new Headers({ authorization: `Bearer ${su.token}` }),
			}),
		).rejects.toThrow();
	});
});

describe("pnpm dev:superuser", () => {
	const run = (args: string[], source: Record<string, string | undefined>) =>
		quietly(() => devSuperuserCommand(args, source, (url) => authPool(url)));

	test("promeut un compte existant (code 0)", async () => {
		await signUp(makeAuth(), SUPERUSER);
		const { result, logs } = await run([SUPERUSER], {
			NODE_ENV: "development",
			DATABASE_URL: db.connectionString,
		});
		expect(result).toBe(0);
		expect(await roleOf(SUPERUSER)).toBe(SUPERUSER_ROLE);
		expect(logs).not.toContain(db.connectionString);
	});

	test("normalise l'email (espaces, majuscules)", async () => {
		await signUp(makeAuth(), SUPERUSER);
		const { result } = await run(["  SuperUser@Radarnaque.TEST "], {
			NODE_ENV: "development",
			DATABASE_URL: db.connectionString,
		});
		expect(result).toBe(0);
		expect(await roleOf(SUPERUSER)).toBe(SUPERUSER_ROLE);
	});

	test("refuse un compte introuvable (code 1), sans le créer", async () => {
		const { result } = await run([SUPERUSER], {
			NODE_ENV: "development",
			DATABASE_URL: db.connectionString,
		});
		expect(result).toBe(1);
		expect(await countUsers(SUPERUSER)).toBe(0);
	});

	test("refuse en production (code 2), sans toucher la base", async () => {
		await signUp(makeAuth(), SUPERUSER);
		for (const source of [
			{ NODE_ENV: "production" },
			{ NODE_ENV: "development", ENV: "production" },
		]) {
			const makePool = vi.fn((url: string) => authPool(url));
			const { result } = await quietly(() =>
				devSuperuserCommand(
					[SUPERUSER],
					{ ...source, DATABASE_URL: db.connectionString },
					makePool,
				),
			);
			expect(result).toBe(2);
			expect(makePool).not.toHaveBeenCalled();
		}
		expect(await roleOf(SUPERUSER)).toBe("user");
	});

	test("refuse un argument absent ou invalide (code 64)", async () => {
		for (const args of [[], ["pas-un-email"]]) {
			const { result } = await run(args, {
				NODE_ENV: "development",
				DATABASE_URL: db.connectionString,
			});
			expect(result).toBe(64);
		}
	});
});
