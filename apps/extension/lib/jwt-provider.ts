import { AuthError } from "./auth-client";

/** Le JWT est renouvelé quand il lui reste moins de 60 s. */
const REFRESH_MARGIN_MS = 60_000;

export interface JwtProvider {
	get(): Promise<string>;
	invalidate(): void;
}

export interface JwtProviderOptions {
	getSessionToken: () => Promise<string | null>;
	fetchJwt: (sessionToken: string) => Promise<string>;
	now?: () => number;
}

/** `exp` du payload (en ms), ou 0 s'il est illisible (le jeton n'est alors pas réutilisé). */
function expiresAt(jwt: string): number {
	try {
		const payload = jwt.split(".")[1] ?? "";
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const { exp } = JSON.parse(atob(base64)) as { exp?: unknown };
		return typeof exp === "number" ? exp * 1000 : 0;
	} catch {
		return 0;
	}
}

/**
 * Fournit le JWT de l'API, gardé **en mémoire uniquement**. Les appels simultanés
 * partagent une seule requête vers `/auth/token`.
 */
export function createJwtProvider({
	getSessionToken,
	fetchJwt,
	now = Date.now,
}: JwtProviderOptions): JwtProvider {
	let cached: { jwt: string; expiresAt: number } | null = null;
	let inflight: Promise<string> | null = null;
	// Incrémenté par `invalidate` : une requête lancée avant n'alimente plus le cache.
	let generation = 0;

	async function refresh(started: number): Promise<string> {
		const sessionToken = await getSessionToken();
		if (!sessionToken) throw new AuthError("session_expired");
		const jwt = await fetchJwt(sessionToken);
		if (started === generation) cached = { jwt, expiresAt: expiresAt(jwt) };
		return jwt;
	}

	return {
		get() {
			if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) {
				return Promise.resolve(cached.jwt);
			}
			if (!inflight) {
				const started = generation;
				const pending = refresh(started).finally(() => {
					if (inflight === pending) inflight = null;
				});
				inflight = pending;
			}
			return inflight;
		},
		invalidate() {
			generation += 1;
			cached = null;
			inflight = null;
		},
	};
}
