import type { ApiErrorBody, Me } from "@radarnaque/shared";
import { AuthError } from "./auth-client";
import { PUBLIC_URL } from "./config";
import type { JwtProvider } from "./jwt-provider";

/** Erreur de l'API autre qu'un 401 (y compris 503 `auth_unavailable`). */
export class ApiRequestError extends Error {
	readonly status: number;
	readonly body: ApiErrorBody;

	constructor(status: number, body: ApiErrorBody) {
		super(`${status} ${body.error.code}`);
		this.name = "ApiRequestError";
		this.status = status;
		this.body = body;
	}
}

export interface ApiClientOptions {
	jwt: JwtProvider;
	fetch: typeof fetch;
	/** Appelé quand la session n'est plus valable : déconnexion locale. */
	onUnauthenticated: () => void | Promise<void>;
}

export interface ApiClient {
	getMe(): Promise<Me>;
}

async function errorBody(res: Response): Promise<ApiErrorBody> {
	const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
	if (typeof body?.error?.code === "string") return body;
	return {
		error: { code: `http_${res.status}`, message: res.statusText, details: {} },
	};
}

export function createApiClient({
	jwt,
	fetch,
	onUnauthenticated,
}: ApiClientOptions): ApiClient {
	async function sessionExpired(): Promise<never> {
		await onUnauthenticated();
		throw new AuthError("session_expired");
	}

	async function send(path: string): Promise<Response> {
		let token: string;
		try {
			token = await jwt.get();
		} catch (error) {
			// Session révoquée ou expirée côté auth : même issue qu'un second 401.
			if (error instanceof AuthError && error.code === "session_expired") {
				return sessionExpired();
			}
			throw error;
		}
		try {
			return await fetch(`${PUBLIC_URL}${path}`, {
				headers: { authorization: `Bearer ${token}` },
				credentials: "omit",
			});
		} catch {
			throw new AuthError("network");
		}
	}

	/**
	 * Un 401 déclenche **un** renouvellement du JWT ; un second 401 déconnecte.
	 * Les 5xx (dont 503 `auth_unavailable`) ne touchent jamais à la session.
	 */
	async function getJson<T>(path: string): Promise<T> {
		let res = await send(path);
		if (res.status === 401) {
			jwt.invalidate();
			res = await send(path);
			if (res.status === 401) return sessionExpired();
		}
		if (!res.ok) throw new ApiRequestError(res.status, await errorBody(res));
		return (await res.json()) as T;
	}

	return {
		getMe: () => getJson<Me>("/api/me"),
	};
}
