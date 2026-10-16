import { getConnInfo } from "@hono/node-server/conninfo";
import type { Locale } from "@radarnaque/shared";
import { isAPIError } from "better-auth/api";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type Auth, trustedOrigins } from "./auth";
import type { Env } from "./env";
import type { Mailer, MemoryMailer } from "./mail/mailer";
import { createRateLimiter } from "./rate-limit";
import { startSignIn } from "./sign-in";

export interface CreateAppOptions {
	auth: Auth;
	mailer: Mailer;
	env: Env;
	/** Copie des emails envoyés, lue par `/auth/dev/last-email` (développement uniquement). */
	devMailer?: MemoryMailer;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Même validateur que Better Auth (zod 4, `z.email()`) : ce qui passe ici, il l'accepte. */
const EMAIL_SCHEMA = z.email();
const LOCALES: readonly Locale[] = ["fr", "nl"];

function apiError(code: string, message: string) {
	return { error: { code, message, details: {} } };
}

/** `trim` + minuscules ; `null` si Better Auth refuserait l'adresse. */
export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return email.length <= 254 && EMAIL_SCHEMA.safeParse(email).success
		? email
		: null;
}

/**
 * IP du client : premier élément de X-Forwarded-For (posé par Caddy), sinon l'adresse
 * de la socket ; `"unknown"` hors de @hono/node-server (tests via `app.request`).
 */
function clientIp(c: Context): string {
	const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
	if (forwarded) return forwarded;
	try {
		return getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** Extrait le lien magique et le code d'un email de connexion combiné. */
function parseSignInEmail(text: string): { url: string; otp: string } | null {
	const url = text.match(/https?:\/\/\S+\/magic-link\/verify\?\S+/)?.[0];
	if (!url) return null;
	const otp = text.replace(url, "").match(/\b(\d{6})\b/)?.[1];
	return otp ? { url, otp } : null;
}

export function createApp({ auth, mailer, env, devMailer }: CreateAppOptions) {
	const app = new Hono();
	const origins = new Set(trustedOrigins(env));
	const ipLimiter = createRateLimiter({ max: 20, windowMs: 15 * 60_000 });
	const emailLimiter = createRateLimiter({ max: 5, windowMs: 15 * 60_000 });

	app.onError((error, c) => {
		// Une APIError de Better Auth (appelé via auth.api) garde son statut et son code.
		if (isAPIError(error) && error.statusCode < 500) {
			const code = String(error.body?.code ?? error.status).toLowerCase();
			return c.json(
				apiError(code, error.body?.message ?? error.message),
				error.statusCode as ContentfulStatusCode,
			);
		}
		console.error(`[auth] ${c.req.method} ${c.req.path} a échoué`, error);
		return c.json(apiError("internal_error", "Erreur interne"), 500);
	});

	// Toute requête qui modifie l'état et porte une Origin étrangère est refusée, y compris
	// vers Better Auth (qui ne contrôle l'Origin que si des cookies sont présents).
	app.use("/auth/*", async (c, next) => {
		const origin = c.req.header("origin");
		if (!SAFE_METHODS.has(c.req.method) && origin && !origins.has(origin)) {
			return c.json(apiError("forbidden", "Origine non autorisée"), 403);
		}
		await next();
	});

	app.get("/auth/health", (c) => c.json({ status: "ok" }));

	app.post("/auth/start", async (c) => {
		const body = await c.req.json<Record<string, unknown>>().catch(() => null);
		const email = normalizeEmail(body?.email);
		if (!email) {
			return c.json(apiError("invalid_email", "Adresse email invalide"), 400);
		}
		// Limite par IP d'abord : une requête refusée ici ne consomme pas le quota de
		// l'adresse visée.
		if (!ipLimiter.hit(clientIp(c)) || !emailLimiter.hit(email)) {
			return c.json(
				apiError("rate_limited", "Trop de demandes, réessayez plus tard"),
				429,
			);
		}
		const locale: Locale = LOCALES.includes(body?.locale as Locale)
			? (body?.locale as Locale)
			: "fr";
		// Même traitement que l'utilisateur existe ou non : Better Auth crée toujours le lien
		// et le code (inscription ouverte), et la réponse ne dépend pas de l'existence du compte.
		await startSignIn(auth, mailer, {
			email,
			locale,
			headers: c.req.raw.headers,
		});
		return c.json({ ok: true });
	});

	app.get("/auth/extension/session-token", async (c) => {
		c.header("Cache-Control", "no-store");
		const session = await auth.api.getSession({ headers: c.req.raw.headers });
		if (!session) {
			return c.json(apiError("unauthenticated", "Aucune session"), 401);
		}
		return c.json({ token: session.session.token });
	});

	if (env.NODE_ENV === "development" && devMailer) {
		app.get("/auth/dev/last-email", (c) => {
			const to = c.req.query("to") ?? "";
			const parsed = parseSignInEmail(devMailer.last(to)?.text ?? "");
			if (!parsed) {
				return c.json(
					apiError("not_found", "Aucun email de connexion pour cette adresse"),
					404,
				);
			}
			return c.json(parsed);
		});
	}

	app.all("/auth/*", (c) => auth.handler(c.req.raw));

	return app;
}
