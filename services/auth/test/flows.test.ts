import { randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { type MailMessage, MemoryMailer } from "../src/mail/mailer";
import {
	authPool,
	migrateFresh,
	type StartedPg,
	startPg,
	testEnv,
} from "./helpers";

let db: StartedPg;
let pool: pg.Pool;

beforeAll(async () => {
	db = await startPg();
	pool = authPool(db.connectionString);
	await migrateFresh(
		createAuth({
			pool,
			env: testEnv({ DATABASE_URL: db.connectionString }),
			onUserCreated: async () => {},
		}),
	);
}, 120_000);

afterAll(async () => {
	await pool?.end();
	await db?.stop();
});

interface Harness {
	app: ReturnType<typeof createApp>;
	mailer: MemoryMailer;
	env: Env;
}

function setup({
	onUserCreated = async () => {},
	env: overrides = {},
	dev = false,
}: {
	onUserCreated?: (id: string) => Promise<void>;
	env?: Partial<Env>;
	dev?: boolean;
} = {}): Harness {
	const env = testEnv({ DATABASE_URL: db.connectionString, ...overrides });
	const mailer = new MemoryMailer();
	const auth = createAuth({ pool, env, onUserCreated });
	const app = createApp({
		auth,
		mailer,
		env,
		devMailer: dev ? mailer : undefined,
	});
	return { app, mailer, env };
}

/**
 * Le rate limiting de Better Auth est en mémoire, partagé par tout le processus et
 * indexé par IP : chaque requête reçoit sa propre IP (X-Forwarded-For, comme derrière Caddy).
 */
let ipCounter = 0;
function nextIp(): string {
	ipCounter++;
	return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function call(
	h: Harness,
	path: string,
	init: {
		method?: string;
		json?: unknown;
		headers?: Record<string, string>;
	} = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", nextIp());
	if (init.json !== undefined) headers.set("content-type", "application/json");
	return Promise.resolve(
		h.app.request(path, {
			method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
			headers,
			body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
			redirect: "manual",
		}),
	);
}

/** Corps JSON des réponses de ces routes (champs selon la route). */
interface Body {
	ok?: boolean;
	status?: string;
	token?: string;
	url?: string;
	otp?: string;
	user?: { id: string };
	error?: { code: string; message: string };
}

const json = (res: Response) => res.json() as Promise<Body>;

const extensionOrigin = (h: Harness) =>
	`chrome-extension://${h.env.EXTENSION_ID}`;

function uniqueEmail(prefix: string): string {
	return `${prefix}-${randomUUID().slice(0, 8)}@test.be`;
}

function parseSignIn(msg: MailMessage | undefined): {
	url: string;
	otp: string;
} {
	const text = msg?.text ?? "";
	const url = text.match(/https?:\/\/\S+\/auth\/magic-link\/verify\?\S+/)?.[0];
	const otp = text.replace(url ?? "", "").match(/\b(\d{6})\b/)?.[1];
	if (!url || !otp) throw new Error(`no link/code in email: ${text}`);
	return { url, otp };
}

async function start(
	h: Harness,
	email: string,
	locale = "fr",
): Promise<{ url: string; otp: string }> {
	const res = await call(h, "/auth/start", { json: { email, locale } });
	expect(res.status).toBe(200);
	return parseSignIn(h.mailer.last(email));
}

async function otpSignIn(h: Harness, email: string): Promise<Response> {
	const { otp } = await start(h, email);
	return call(h, "/auth/sign-in/email-otp", {
		json: { email, otp },
		headers: { origin: extensionOrigin(h) },
	});
}

describe("POST /auth/start", () => {
	test("start sends exactly one email with link and 6-digit code", async () => {
		const h = setup();
		const res = await call(h, "/auth/start", {
			json: { email: " Alice@Test.BE ", locale: "nl" },
			headers: { origin: extensionOrigin(h) },
		});
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ ok: true });
		expect(h.mailer.messages).toHaveLength(1);
		const [msg] = h.mailer.messages;
		expect(msg.to).toBe("alice@test.be");
		expect(msg.subject).toBe("Uw aanmelding bij Radarnaque");
		const { url, otp } = parseSignIn(msg);
		expect(url).toContain(`${h.env.PUBLIC_URL}/auth/magic-link/verify?token=`);
		expect(new URL(url).searchParams.get("callbackURL")).toBe("/auth/callback");
		expect(otp).toMatch(/^\d{6}$/);
	});

	test("magic-link and OTP verification rows expire 600 s after creation", async () => {
		const h = setup();
		const email = uniqueEmail("ttl");
		const before = Date.now();
		await start(h, email);
		const after = Date.now();
		const rows = await pool.query<{ identifier: string; expiresAt: Date }>(
			`SELECT identifier, "expiresAt" FROM verification WHERE identifier = $1 OR value LIKE $2`,
			[`sign-in-otp-${email}`, `%"email":"${email}"%`],
		);
		expect(rows.rowCount).toBe(2);
		for (const row of rows.rows) {
			const expires = row.expiresAt.getTime();
			expect(expires).toBeGreaterThanOrEqual(before + 600_000 - 2_000);
			expect(expires).toBeLessThanOrEqual(after + 600_000 + 2_000);
		}
	});

	test("unknown or known email both return 200 {ok:true}", async () => {
		const h = setup();
		const known = uniqueEmail("known");
		expect((await otpSignIn(h, known)).status).toBe(200);
		const unknown = uniqueEmail("unknown");
		for (const email of [known, unknown]) {
			const res = await call(h, "/auth/start", {
				json: { email, locale: "fr" },
			});
			expect(res.status).toBe(200);
			expect(await json(res)).toEqual({ ok: true });
			expect(parseSignIn(h.mailer.last(email)).otp).toMatch(/^\d{6}$/);
		}
	});

	test("invalid email → 400 invalid_email, nothing sent", async () => {
		const h = setup();
		for (const email of [
			"",
			"   ",
			"not-an-email",
			"a@b",
			42,
			// Acceptées par une regex naïve, refusées par z.email() de Better Auth.
			"a<b>@c.de",
			"a,b@c.de",
		]) {
			const res = await call(h, "/auth/start", {
				json: { email, locale: "fr" },
			});
			expect(res.status).toBe(400);
			expect((await json(res)).error?.code).toBe("invalid_email");
		}
		expect(h.mailer.messages).toHaveLength(0);
	});

	test("6th start within 15 min for same email → 429", async () => {
		const h = setup();
		const email = uniqueEmail("limit");
		for (let i = 0; i < 5; i++) {
			// Variations de casse/espaces : même compteur après normalisation.
			const res = await call(h, "/auth/start", {
				json: {
					email: i % 2 ? ` ${email.toUpperCase()} ` : email,
					locale: "fr",
				},
			});
			expect(res.status).toBe(200);
		}
		const res = await call(h, "/auth/start", { json: { email, locale: "fr" } });
		expect(res.status).toBe(429);
		expect((await json(res)).error?.code).toBe("rate_limited");
		expect(h.mailer.messages).toHaveLength(5);
		// Les autres adresses ne sont pas affectées.
		expect(
			(
				await call(h, "/auth/start", {
					json: { email: uniqueEmail("other"), locale: "fr" },
				})
			).status,
		).toBe(200);
	});
});

describe("POST /auth/start target", () => {
	test("start without target keeps /auth/callback", async () => {
		const h = setup();
		const email = uniqueEmail("sans-target");
		const { url } = await start(h, email);
		expect(new URL(url).searchParams.get("callbackURL")).toBe("/auth/callback");
		expect(h.mailer.last(email)?.text).toContain("dans l'extension");
	});

	test("start with target admin links to /admin/", async () => {
		const h = setup();
		const email = uniqueEmail("admin");
		const res = await call(h, "/auth/start", {
			json: { email, locale: "fr", target: "admin" },
		});
		expect(res.status).toBe(200);
		const msg = h.mailer.last(email);
		const { url } = parseSignIn(msg);
		const params = new URL(url).searchParams;
		expect(params.get("callbackURL")).toBe("/admin/");
		expect(params.get("errorCallbackURL")).toBe("/admin/?erreur=lien");
		expect(url).toContain("callbackURL=%2Fadmin%2F");
		expect(msg?.text).toContain("page d'administration");
		expect(msg?.text).not.toContain("extension");
		expect(msg?.html).not.toContain("extension");
	});

	test("start with target admin ignores locale nl", async () => {
		const h = setup();
		const email = uniqueEmail("admin-nl");
		const res = await call(h, "/auth/start", {
			json: { email, locale: "nl", target: "admin" },
		});
		expect(res.status).toBe(200);
		const msg = h.mailer.last(email);
		expect(msg?.subject).toBe("Votre connexion à Radarnaque");
		expect(msg?.text).toContain("page d'administration");
	});

	test("start with target extension behaves like no target", async () => {
		const h = setup();
		const email = uniqueEmail("ext");
		const res = await call(h, "/auth/start", {
			json: { email, locale: "fr", target: "extension" },
		});
		expect(res.status).toBe(200);
		const { url } = parseSignIn(h.mailer.last(email));
		expect(new URL(url).searchParams.get("callbackURL")).toBe("/auth/callback");
	});

	test("start rejects an unknown target", async () => {
		const h = setup();
		const email = uniqueEmail("cible");
		for (const target of ["autre", "", "ADMIN", 42, null, {}]) {
			const res = await call(h, "/auth/start", {
				json: { email, locale: "fr", target },
			});
			expect(res.status, JSON.stringify(target)).toBe(400);
			expect((await json(res)).error?.code).toBe("invalid_target");
		}
		expect(h.mailer.messages).toHaveLength(0);
	});
});

describe("POST /auth/start per-IP limit", () => {
	test("21st start from the same IP (distinct emails) → 429", async () => {
		const h = setup();
		const ip = nextIp();
		for (let i = 0; i < 20; i++) {
			const res = await call(h, "/auth/start", {
				json: { email: uniqueEmail(`ip${i}`), locale: "fr" },
				headers: { "x-forwarded-for": ip },
			});
			expect(res.status).toBe(200);
		}
		const res = await call(h, "/auth/start", {
			json: { email: uniqueEmail("ip20"), locale: "fr" },
			headers: { "x-forwarded-for": ip },
		});
		expect(res.status).toBe(429);
		expect((await json(res)).error?.code).toBe("rate_limited");
		expect(h.mailer.messages).toHaveLength(20);
		// La première IP de X-Forwarded-For sert de clé ; une autre IP n'est pas affectée.
		const other = await call(h, "/auth/start", {
			json: { email: uniqueEmail("ip-other"), locale: "fr" },
			headers: { "x-forwarded-for": `${nextIp()}, ${ip}` },
		});
		expect(other.status).toBe(200);
	});

	test("requests refused by the IP limit do not consume the email's quota", async () => {
		const h = setup();
		const attacker = nextIp();
		for (let i = 0; i < 20; i++) {
			await call(h, "/auth/start", {
				json: { email: uniqueEmail(`flood${i}`), locale: "fr" },
				headers: { "x-forwarded-for": attacker },
			});
		}
		const victim = uniqueEmail("victim");
		for (let i = 0; i < 10; i++) {
			const res = await call(h, "/auth/start", {
				json: { email: victim, locale: "fr" },
				headers: { "x-forwarded-for": attacker },
			});
			expect(res.status).toBe(429);
		}
		for (let i = 0; i < 5; i++) {
			expect(
				(
					await call(h, "/auth/start", {
						json: { email: victim, locale: "fr" },
					})
				).status,
			).toBe(200);
		}
		expect(
			(await call(h, "/auth/start", { json: { email: victim, locale: "fr" } }))
				.status,
		).toBe(429);
	});
});

describe("untrusted origins", () => {
	test("request from untrusted Origin is rejected", async () => {
		const h = setup();
		const email = uniqueEmail("evil");
		const res = await call(h, "/auth/start", {
			json: { email, locale: "fr" },
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
		expect(h.mailer.messages).toHaveLength(0);

		// Même règle pour les routes Better Auth (ici, la connexion par code).
		const { otp } = await start(h, email);
		const signIn = await call(h, "/auth/sign-in/email-otp", {
			json: { email, otp },
			headers: { origin: "https://evil.example" },
		});
		expect(signIn.status).toBe(403);
		expect(signIn.headers.get("set-auth-token")).toBeNull();
	});
});

describe("OTP sign-in", () => {
	test("OTP sign-in returns set-auth-token, usable to get a JWT", async () => {
		const h = setup();
		const email = uniqueEmail("otp");
		const res = await otpSignIn(h, email);
		expect(res.status).toBe(200);
		const body = await json(res);
		const token = res.headers.get("set-auth-token");
		expect(token).toBeTruthy();

		const tokenRes = await call(h, "/auth/token", {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(tokenRes.status).toBe(200);
		const { token: jwt } = await json(tokenRes);
		const jwks = (await (await call(h, "/auth/jwks")).json()) as JSONWebKeySet;
		const { payload, protectedHeader } = await jwtVerify(
			String(jwt),
			createLocalJWKSet(jwks),
			{
				issuer: h.env.PUBLIC_URL,
				audience: h.env.PUBLIC_URL,
			},
		);
		expect(payload.sub).toBe(body.user?.id);
		expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(900);
		expect(protectedHeader.alg).toBe("EdDSA");
	});

	test("wrong OTP → non-2xx and no set-auth-token header", async () => {
		const h = setup();
		const email = uniqueEmail("wrong");
		const { otp } = await start(h, email);
		const wrong = otp === "000000" ? "111111" : "000000";
		const res = await call(h, "/auth/sign-in/email-otp", {
			json: { email, otp: wrong },
			headers: { origin: extensionOrigin(h) },
		});
		expect(res.ok).toBe(false);
		expect(res.headers.get("set-auth-token")).toBeNull();
	});
});

describe("GET /auth/extension/session-token", () => {
	test("magic link verify then /auth/extension/session-token returns bearer token", async () => {
		const h = setup();
		const email = uniqueEmail("link");
		const { url } = await start(h, email);
		const verifyUrl = new URL(url);
		const verify = await call(h, verifyUrl.pathname + verifyUrl.search);
		expect(verify.status).toBe(302);
		expect(verify.headers.get("location")).toBe(
			`${h.env.PUBLIC_URL}/auth/callback`,
		);
		const cookie = verify.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		expect(cookie).toContain("session_token=");

		const res = await call(h, "/auth/extension/session-token", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const { token } = await json(res);
		expect(typeof token).toBe("string");

		const jwtRes = await call(h, "/auth/token", {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(jwtRes.status).toBe(200);
		expect((await json(jwtRes)).token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
	});

	test("session-token without session → 401", async () => {
		const h = setup();
		const res = await call(h, "/auth/extension/session-token");
		expect(res.status).toBe(401);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect((await json(res)).error?.code).toBe("unauthenticated");
	});
});

describe("Better Auth admin routes", () => {
	test("auth admin routes return 404 even for an admin session", async () => {
		const h = setup();
		const email = uniqueEmail("admin-http");
		const signIn = await otpSignIn(h, email);
		expect(signIn.status).toBe(200);
		const cookie = signIn.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		await pool.query(`UPDATE "user" SET role = 'admin' WHERE email = $1`, [
			email,
		]);

		const list = await call(h, "/auth/admin/list-users", {
			headers: { cookie },
		});
		expect(list.status).toBe(404);
		expect((await json(list)).error?.code).toBe("not_found");

		const impersonate = await call(h, "/auth/admin/impersonate-user", {
			json: { userId: "x" },
			headers: { cookie, origin: h.env.PUBLIC_URL },
		});
		expect(impersonate.status).toBe(404);
		expect((await json(impersonate)).error?.code).toBe("not_found");
	});
});

describe("user creation hook", () => {
	test("new user triggers onUserCreated exactly once; failing hook does not break sign-in", async () => {
		const created: string[] = [];
		const h = setup({
			onUserCreated: async (id) => {
				created.push(id);
			},
		});
		const email = uniqueEmail("hook");
		const first = await otpSignIn(h, email);
		expect(first.status).toBe(200);
		const userId = (await json(first)).user?.id;
		expect((await otpSignIn(h, email)).status).toBe(200);
		expect(created).toEqual([userId]);

		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const failing = setup({
				onUserCreated: async () => {
					throw new Error("api down");
				},
			});
			const res = await otpSignIn(failing, uniqueEmail("hook-fail"));
			expect(res.status).toBe(200);
			expect(res.headers.get("set-auth-token")).toBeTruthy();
			expect(errors).toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});

describe("misc routes", () => {
	test("health", async () => {
		const res = await call(setup(), "/auth/health");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ status: "ok" });
	});

	test("dev last-email route returns link and code in development", async () => {
		const h = setup({ env: { NODE_ENV: "development" }, dev: true });
		const email = uniqueEmail("dev");
		const sent = await start(h, email);
		const res = await call(
			h,
			`/auth/dev/last-email?to=${encodeURIComponent(email)}`,
		);
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual(sent);
		expect(
			(
				await call(
					h,
					`/auth/dev/last-email?to=${encodeURIComponent(uniqueEmail("none"))}`,
				)
			).status,
		).toBe(404);
	});

	test("dev last-email route is 404 when NODE_ENV=production", async () => {
		for (const NODE_ENV of ["production", "test"] as const) {
			const h = setup({ env: { NODE_ENV }, dev: true });
			const email = uniqueEmail("prod");
			await start(h, email);
			const res = await call(
				h,
				`/auth/dev/last-email?to=${encodeURIComponent(email)}`,
			);
			expect(res.status).toBe(404);
		}
	});

	test("Better Auth's own email-sending endpoints are disabled (404, no email)", async () => {
		const h = setup();
		const email = uniqueEmail("direct");
		const attempts: [string, Record<string, unknown>][] = [
			["/auth/sign-in/magic-link", { email, callbackURL: "/auth/callback" }],
			["/auth/email-otp/send-verification-otp", { email, type: "sign-in" }],
			[
				"/auth/email-otp/send-verification-otp",
				{ email, type: "email-verification" },
			],
			["/auth/email-otp/request-password-reset", { email }],
			["/auth/forget-password/email-otp", { email }],
			["/auth/email-otp/request-email-change", { newEmail: email }],
		];
		for (const [path, body] of attempts) {
			const res = await call(h, path, {
				json: body,
				headers: { origin: h.env.PUBLIC_URL },
			});
			expect(res.status, path).toBe(404);
		}
		expect(h.mailer.messages).toHaveLength(0);
		// Les routes de vérification restent ouvertes.
		const { otp } = await start(h, email);
		const signIn = await call(h, "/auth/sign-in/email-otp", {
			json: { email, otp },
			headers: { origin: h.env.PUBLIC_URL },
		});
		expect(signIn.status).toBe(200);
	});

	test("a Better Auth APIError keeps its own status instead of 500", async () => {
		const env = testEnv({ DATABASE_URL: db.connectionString });
		const mailer = new MemoryMailer();
		const auth = createAuth({ pool, env, onUserCreated: async () => {} });
		const throwing = {
			...auth,
			api: {
				...auth.api,
				getSession: async () => {
					throw new APIError("BAD_REQUEST", {
						code: "INVALID_EMAIL",
						message: "Invalid email",
					});
				},
			},
		} as unknown as typeof auth;
		const app = createApp({ auth: throwing, mailer, env });
		const res = await app.request("/auth/extension/session-token");
		expect(res.status).toBe(400);
		expect((await json(res)).error?.code).toBe("invalid_email");
	});
});
