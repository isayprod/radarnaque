import type { Locale } from "@radarnaque/shared";
import { PUBLIC_URL } from "./config";

export type AuthErrorCode =
	| "invalid_email"
	| "rate_limited"
	| "invalid_otp"
	| "session_expired"
	| "network";

export class AuthError extends Error {
	readonly code: AuthErrorCode;

	constructor(code: AuthErrorCode) {
		super(code);
		this.name = "AuthError";
		this.code = code;
	}
}

/**
 * Requête vers le service auth. Pas de cookies (`credentials: "omit"`) : l'extension
 * s'authentifie uniquement par jeton bearer. Une panne réseau donne `AuthError("network")`.
 */
async function request(
	path: string,
	init: { method: "GET" | "POST"; body?: unknown; bearer?: string },
): Promise<Response> {
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers["content-type"] = "application/json";
	if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
	try {
		return await fetch(`${PUBLIC_URL}${path}`, {
			method: init.method,
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			credentials: "omit",
		});
	} catch {
		throw new AuthError("network");
	}
}

/** Demande l'email de connexion (lien magique + code). `email` est déjà normalisé. */
export async function startSignIn(
	email: string,
	locale: Locale,
): Promise<void> {
	const res = await request("/auth/start", {
		method: "POST",
		body: { email, locale },
	});
	if (res.ok) return;
	if (res.status === 429) throw new AuthError("rate_limited");
	if (res.status === 400) throw new AuthError("invalid_email");
	throw new AuthError("network");
}

/** Échange le code à 6 chiffres contre un jeton de session (en-tête `set-auth-token`). */
export async function verifyOtp(email: string, otp: string): Promise<string> {
	const res = await request("/auth/sign-in/email-otp", {
		method: "POST",
		body: { email, otp },
	});
	if (res.status === 429) throw new AuthError("rate_limited");
	if (res.status >= 500) throw new AuthError("network");
	const token = res.ok ? res.headers.get("set-auth-token") : null;
	if (!token) throw new AuthError("invalid_otp");
	return token;
}

/** Échange le jeton de session contre un JWT de 15 minutes. */
export async function fetchJwt(sessionToken: string): Promise<string> {
	const res = await request("/auth/token", {
		method: "GET",
		bearer: sessionToken,
	});
	if (res.status === 401) throw new AuthError("session_expired");
	if (!res.ok) throw new AuthError("network");
	const body = (await res.json().catch(() => null)) as {
		token?: unknown;
	} | null;
	if (typeof body?.token !== "string" || !body.token) {
		throw new AuthError("network");
	}
	return body.token;
}

/** Révoque la session côté serveur. Les erreurs sont ignorées : la déconnexion locale suit. */
export async function signOutRemote(sessionToken: string): Promise<void> {
	try {
		await request("/auth/sign-out", {
			method: "POST",
			body: {},
			bearer: sessionToken,
		});
	} catch {
		// Hors ligne : la session expirera d'elle-même côté serveur.
	}
}
