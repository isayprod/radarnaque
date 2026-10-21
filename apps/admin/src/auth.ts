// Service auth, même origine : le cookie de session part avec chaque requête
// (`credentials: "same-origin"`), contrairement à l'extension qui travaille par jeton bearer.

export type AuthErrorCode = "rate_limited" | "invalid_code" | "unavailable";

export class AuthError extends Error {
	readonly code: AuthErrorCode;

	constructor(code: AuthErrorCode) {
		super(code);
		this.name = "AuthError";
		this.code = code;
	}
}

async function request(
	path: string,
	method: "GET" | "POST",
	body?: unknown,
): Promise<Response> {
	try {
		return await fetch(path, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "same-origin",
		});
	} catch {
		throw new AuthError("unavailable");
	}
}

/** Envoie l'email de connexion (lien magique qui ramène sur /admin/, et code à 6 chiffres). */
export async function startSignIn(email: string): Promise<void> {
	const res = await request("/auth/start", "POST", {
		email,
		locale: "fr",
		target: "admin",
	});
	if (res.ok) return;
	throw new AuthError(res.status === 429 ? "rate_limited" : "unavailable");
}

/** Échange le code contre une session (cookie posé par le service auth). */
export async function verifyCode(email: string, otp: string): Promise<void> {
	const res = await request("/auth/sign-in/email-otp", "POST", { email, otp });
	if (res.ok) return;
	if (res.status === 429) throw new AuthError("rate_limited");
	if (res.status >= 500) throw new AuthError("unavailable");
	throw new AuthError("invalid_code");
}

/** JWT court pour l'API ; `null` sans session (401). */
export async function fetchToken(): Promise<string | null> {
	const res = await request("/auth/token", "GET");
	if (res.status === 401) return null;
	if (!res.ok) throw new AuthError("unavailable");
	const body = (await res.json().catch(() => null)) as {
		token?: unknown;
	} | null;
	if (typeof body?.token !== "string" || !body.token) {
		throw new AuthError("unavailable");
	}
	return body.token;
}

export async function signOut(): Promise<void> {
	const res = await request("/auth/sign-out", "POST", {});
	if (!res.ok) throw new AuthError("unavailable");
}
