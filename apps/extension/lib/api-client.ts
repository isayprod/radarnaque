import type {
	AnalysisResult,
	ApiErrorBody,
	Me,
	ScanIn,
} from "@radarnaque/shared";
import { AuthError } from "./auth-client";
import { PUBLIC_URL } from "./config";
import type { JwtProvider } from "./jwt-provider";
import { readSse, type SseMessage } from "./sse";

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

/**
 * `session_expired` levé par `jwt.get()` avant le premier envoi : aucune requête n'est
 * partie. Même code que tout `session_expired` (les autres routes n'y voient pas de
 * différence) ; seule la suppression du compte le distingue.
 */
export class SessionExpiredBeforeSendError extends AuthError {
	constructor() {
		super("session_expired");
		this.name = "SessionExpiredBeforeSendError";
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
	/**
	 * `DELETE /api/me` : suppression du compte (`204` sans corps). Un 401 passe par le
	 * renouvellement du JWT, puis devient `session_expired` ; un autre refus lève
	 * `ApiRequestError`. Un `jwt.get()` refusé avant tout envoi lève
	 * `SessionExpiredBeforeSendError`.
	 */
	deleteMe(): Promise<void>;
	/** `POST /api/scans` : le corps doit sortir de `toScanIn` (identité retirée, bornes). */
	scan(body: ScanIn): Promise<AnalysisResult>;
	/**
	 * `POST /api/scans/stream` : même corps que `scan`. Un refus avant le flux (401 après
	 * renouvellement, 402, 403, 422, 429) lève comme `scan` ; sinon, les événements SSE
	 * du flux. `signal` annule la requête et la lecture.
	 */
	scanStream(
		body: ScanIn,
		signal: AbortSignal,
	): Promise<AsyncIterable<SseMessage>>;
}

async function errorBody(res: Response): Promise<ApiErrorBody> {
	const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
	if (typeof body?.error?.code === "string") return body;
	return {
		error: { code: `http_${res.status}`, message: res.statusText, details: {} },
	};
}

/** Méthode, corps JSON et signal d'une requête ; les en-têtes sont fixés par `send`. */
interface SendInit {
	method?: "GET" | "POST" | "DELETE";
	body?: string;
	signal?: AbortSignal;
}

export function createApiClient({
	jwt,
	fetch,
	onUnauthenticated,
}: ApiClientOptions): ApiClient {
	async function sessionExpired(beforeSend = false): Promise<never> {
		await onUnauthenticated();
		throw beforeSend
			? new SessionExpiredBeforeSendError()
			: new AuthError("session_expired");
	}

	/** `retry` : second envoi après un 401, donc une requête est déjà partie. */
	async function send(
		path: string,
		init: SendInit = {},
		retry = false,
	): Promise<Response> {
		let token: string;
		try {
			token = await jwt.get();
		} catch (error) {
			// Session révoquée ou expirée côté auth : même issue qu'un second 401.
			if (error instanceof AuthError && error.code === "session_expired") {
				return sessionExpired(!retry);
			}
			throw error;
		}
		try {
			const headers: Record<string, string> = {
				authorization: `Bearer ${token}`,
			};
			if (init.body !== undefined) headers["content-type"] = "application/json";
			return await fetch(`${PUBLIC_URL}${path}`, {
				...init,
				headers,
				credentials: "omit",
			});
		} catch {
			throw new AuthError("network");
		}
	}

	/**
	 * Un 401 déclenche **un** renouvellement du JWT ; un second 401 déconnecte.
	 * Les 5xx (dont 503 `auth_unavailable`) ne touchent jamais à la session.
	 * Toute autre réponse en erreur lève `ApiRequestError`.
	 */
	async function request(path: string, init?: SendInit): Promise<Response> {
		let res = await send(path, init);
		if (res.status === 401) {
			jwt.invalidate();
			res = await send(path, init, true);
			if (res.status === 401) return sessionExpired();
		}
		if (!res.ok) throw new ApiRequestError(res.status, await errorBody(res));
		return res;
	}

	async function requestJson<T>(path: string, init?: SendInit): Promise<T> {
		return (await (await request(path, init)).json()) as T;
	}

	return {
		getMe: () => requestJson<Me>("/api/me"),
		async deleteMe() {
			// Réponse 204 : aucun corps à lire.
			await request("/api/me", { method: "DELETE" });
		},
		scan: (body) =>
			requestJson<AnalysisResult>("/api/scans", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		async scanStream(body, signal) {
			const res = await request("/api/scans/stream", {
				method: "POST",
				body: JSON.stringify(body),
				signal,
			});
			// Sans corps : un flux vide, donc interrompu pour l'appelant.
			return readSse(res.body ?? new Blob().stream());
		},
	};
}
