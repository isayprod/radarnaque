import type { ApiErrorBody } from "@radarnaque/shared";

export class ApiFailure extends Error {
	readonly status: number;
	readonly code: string;
	/** `details` de l'API (par exemple `reason` d'un 409) ; vide à défaut. */
	readonly details: Record<string, unknown>;

	/** `message` est celui de l'API (en français) ; à défaut, le code. */
	constructor(
		status: number,
		code: string,
		message: string = code,
		details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "ApiFailure";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export interface AdminApi {
	get<T>(path: string): Promise<T>;
	send<T>(
		method: "POST" | "PATCH" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<T>;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function errorOf(res: Response): Promise<{
	code: string;
	message: string | undefined;
	details: Record<string, unknown>;
}> {
	const body = (await res
		.json()
		.catch(() => null)) as Partial<ApiErrorBody> | null;
	const { code, message, details } = body?.error ?? {};
	return {
		code: typeof code === "string" ? code : "http_error",
		message: typeof message === "string" && message ? message : undefined,
		details:
			typeof details === "object" && details !== null && !Array.isArray(details)
				? details
				: {},
	};
}

/**
 * Client de l'API pour l'admin. Le JWT reste en mémoire (jamais de stockage) : un 401 en
 * demande un nouveau et rejoue la requête une seule fois, puis `onSignedOut`. Un 403
 * `admin_required` appelle `onForbidden` sans nouvelle tentative.
 */
export function createApi(deps: {
	fetchToken: () => Promise<string | null>;
	onSignedOut: () => void;
	onForbidden: () => void;
}): AdminApi {
	let jwt: string | null = null;
	// Renouvellement partagé : toutes les requêtes en attente d'un jeton (premier appel ou
	// 401) attendent la même demande, au lieu d'en lancer une chacune.
	let renewing: Promise<string | null> | null = null;
	let ended = false;

	const renew = (): Promise<string | null> => {
		if (!renewing) {
			const pending: Promise<string | null> = deps
				.fetchToken()
				.then((token) => {
					jwt = token;
					return token;
				})
				.finally(() => {
					if (renewing === pending) renewing = null;
				});
			renewing = pending;
		}
		return renewing;
	};

	const call = (method: Method, path: string, body: unknown, token: string) =>
		fetch(path, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: "same-origin",
		});

	// `onSignedOut` n'est appelé qu'une fois, quel que soit le nombre de requêtes en échec.
	const signedOut = (): never => {
		jwt = null;
		if (!ended) {
			ended = true;
			deps.onSignedOut();
		}
		throw new ApiFailure(401, "unauthenticated");
	};

	async function request<T>(
		method: Method,
		path: string,
		body?: unknown,
	): Promise<T> {
		if (ended) return signedOut();
		const used = jwt ?? (await renew());
		if (!used) return signedOut();
		let res = await call(method, path, body, used);
		if (res.status === 401) {
			// Le jeton refusé est invalidé une fois ; si un autre appel l'a déjà remplacé
			// (ou le remplace en ce moment), on rejoue avec le courant sans le redemander.
			if (jwt === used) jwt = null;
			const fresh = jwt ?? (await renew());
			if (!fresh) return signedOut();
			res = await call(method, path, body, fresh);
			if (res.status === 401) return signedOut();
		}
		if (!res.ok) {
			const { code, message, details } = await errorOf(res);
			if (res.status === 403 && code === "admin_required") deps.onForbidden();
			throw new ApiFailure(res.status, code, message, details);
		}
		if (res.status === 204) return undefined as T;
		return (await res.json()) as T;
	}

	return {
		get: <T>(path: string) => request<T>("GET", path),
		send: <T>(
			method: "POST" | "PATCH" | "DELETE",
			path: string,
			body?: unknown,
		) => request<T>(method, path, body),
	};
}
