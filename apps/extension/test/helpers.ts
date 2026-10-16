import type { Me } from "@radarnaque/shared";
import { vi } from "vitest";

function base64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** JWT factice (non signé) dont le payload porte `exp` (en secondes). */
export function makeJwt(expSeconds: number, sub = "user-1"): string {
	return `${base64url({ alg: "EdDSA", typ: "JWT" })}.${base64url({ sub, exp: expSeconds })}.c2ln`;
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export function errorResponse(status: number, code: string): Response {
	return jsonResponse(status, { error: { code, message: code, details: {} } });
}

/** `fetch` simulé qui renvoie les réponses dans l'ordre. */
export function fetchSequence(...responses: Array<Response | Error>) {
	const fn = vi.fn<typeof fetch>();
	for (const response of responses) {
		if (response instanceof Error) fn.mockRejectedValueOnce(response);
		else fn.mockResolvedValueOnce(response);
	}
	return fn;
}

export function requestOf(fn: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) {
	const [input, init] = fn.mock.calls[i] ?? [];
	return {
		url: String(input),
		method: init?.method ?? "GET",
		headers: new Headers(init?.headers),
		body: init?.body ? JSON.parse(String(init.body)) : undefined,
		credentials: init?.credentials,
	};
}

export const trialMe: Me = {
	userId: "user-1",
	email: "a@b.be",
	role: "user",
	plan: "trial",
	features: ["card_icons", "image_scan"],
	unlimited: false,
	periodStart: null,
	quotas: [
		{ scanKind: "text", limit: 3, used: 0, remaining: 3 },
		{ scanKind: "image", limit: 3, used: 0, remaining: 3 },
	],
	totalCap: { scanKind: null, limit: 3, used: 0, remaining: 3 },
};
