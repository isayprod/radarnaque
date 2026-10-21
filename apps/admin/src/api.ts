import type { ApiErrorBody } from "@radarnaque/shared";

export class ApiFailure extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string) {
		super(code);
		this.name = "ApiFailure";
		this.status = status;
		this.code = code;
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

async function errorCode(res: Response): Promise<string> {
	const body = (await res
		.json()
		.catch(() => null)) as Partial<ApiErrorBody> | null;
	const code = body?.error?.code;
	return typeof code === "string" ? code : "http_error";
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

	const signedOut = (): never => {
		jwt = null;
		deps.onSignedOut();
		throw new ApiFailure(401, "unauthenticated");
	};

	async function request<T>(
		method: Method,
		path: string,
		body?: unknown,
	): Promise<T> {
		jwt ??= await deps.fetchToken();
		if (!jwt) return signedOut();
		let res = await call(method, path, body, jwt);
		if (res.status === 401) {
			jwt = await deps.fetchToken();
			if (!jwt) return signedOut();
			res = await call(method, path, body, jwt);
			if (res.status === 401) return signedOut();
		}
		if (!res.ok) {
			const code = await errorCode(res);
			if (res.status === 403 && code === "admin_required") deps.onForbidden();
			throw new ApiFailure(res.status, code);
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
