import { describe, expect, test, vi } from "vitest";
import { ApiRequestError, createApiClient } from "../lib/api-client";
import { AuthError } from "../lib/auth-client";
import type { JwtProvider } from "../lib/jwt-provider";
import {
	errorResponse,
	fetchSequence,
	jsonResponse,
	requestOf,
	sampleAnalysis,
	sampleScanIn,
	sseEvent,
	sseResponse,
	trialMe,
} from "./helpers";

function fakeJwt(...tokens: string[]) {
	const get = vi.fn<JwtProvider["get"]>();
	for (const token of tokens) get.mockResolvedValueOnce(token);
	return { get, invalidate: vi.fn<JwtProvider["invalidate"]>() };
}

describe("api client", () => {
	test("getMe sends the JWT and returns Me", async () => {
		const jwt = fakeJwt("jwt-1");
		const fetch = fetchSequence(jsonResponse(200, trialMe));
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		expect(await api.getMe()).toEqual(trialMe);
		const req = requestOf(fetch);
		expect(req.url).toBe("http://localhost:8080/api/me");
		expect(req.headers.get("authorization")).toBe("Bearer jwt-1");
		expect(req.credentials).toBe("omit");
		expect(jwt.invalidate).not.toHaveBeenCalled();
	});

	test("api client retries once after 401 then calls onUnauthenticated", async () => {
		// Premier 401 puis succès : un seul renouvellement, pas de déconnexion.
		const jwt = fakeJwt("old", "new");
		const fetch = fetchSequence(
			errorResponse(401, "unauthenticated"),
			jsonResponse(200, trialMe),
		);
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		expect(await api.getMe()).toEqual(trialMe);
		expect(jwt.invalidate).toHaveBeenCalledTimes(1);
		expect(requestOf(fetch, 1).headers.get("authorization")).toBe("Bearer new");
		expect(onUnauthenticated).not.toHaveBeenCalled();

		// Deux 401 : déconnexion locale et session_expired, sans troisième essai.
		const jwt2 = fakeJwt("old", "new");
		const fetch2 = fetchSequence(
			errorResponse(401, "unauthenticated"),
			errorResponse(401, "unauthenticated"),
		);
		const onUnauthenticated2 = vi.fn();
		const api2 = createApiClient({
			jwt: jwt2,
			fetch: fetch2,
			onUnauthenticated: onUnauthenticated2,
		});
		const error = await api2.getMe().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AuthError);
		expect((error as AuthError).code).toBe("session_expired");
		expect(fetch2).toHaveBeenCalledTimes(2);
		expect(jwt2.invalidate).toHaveBeenCalledTimes(1);
		expect(onUnauthenticated2).toHaveBeenCalledTimes(1);
	});

	test("session rejected by /auth/token → onUnauthenticated and session_expired", async () => {
		const jwt = fakeJwt();
		jwt.get.mockRejectedValueOnce(new AuthError("session_expired"));
		const fetch = fetchSequence();
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		await expect(api.getMe()).rejects.toMatchObject({
			code: "session_expired",
		});
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("503 auth_unavailable is not an auth failure: no retry, no sign-out", async () => {
		const jwt = fakeJwt("jwt-1");
		const fetch = fetchSequence(errorResponse(503, "auth_unavailable"));
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		const error = await api.getMe().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect((error as ApiRequestError).status).toBe(503);
		expect((error as ApiRequestError).body.error.code).toBe("auth_unavailable");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(jwt.invalidate).not.toHaveBeenCalled();
		expect(onUnauthenticated).not.toHaveBeenCalled();
	});

	test("other errors → ApiRequestError; non-JSON body gets a synthetic code", async () => {
		const jwt = fakeJwt("a", "b");
		const fetch = fetchSequence(
			errorResponse(403, "forbidden"),
			new Response("<html>Bad Gateway</html>", { status: 502 }),
		);
		const api = createApiClient({ jwt, fetch, onUnauthenticated: vi.fn() });
		await expect(api.getMe()).rejects.toMatchObject({
			status: 403,
			body: { error: { code: "forbidden" } },
		});
		await expect(api.getMe()).rejects.toMatchObject({
			status: 502,
			body: { error: { code: "http_502" } },
		});
	});

	test("network failure → AuthError network, session kept", async () => {
		const jwt = fakeJwt("jwt-1");
		const fetch = fetchSequence(new TypeError("Failed to fetch"));
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		await expect(api.getMe()).rejects.toMatchObject({ code: "network" });
		expect(onUnauthenticated).not.toHaveBeenCalled();
		expect(jwt.invalidate).not.toHaveBeenCalled();
	});

	test("scan posts the JSON body with the JWT and returns the analysis", async () => {
		const jwt = fakeJwt("jwt-1");
		const fetch = fetchSequence(jsonResponse(200, sampleAnalysis));
		const api = createApiClient({ jwt, fetch, onUnauthenticated: vi.fn() });
		expect(await api.scan(sampleScanIn)).toEqual(sampleAnalysis);
		const req = requestOf(fetch);
		expect(req.url).toBe("http://localhost:8080/api/scans");
		expect(req.method).toBe("POST");
		expect(req.headers.get("authorization")).toBe("Bearer jwt-1");
		expect(req.headers.get("content-type")).toBe("application/json");
		expect(req.credentials).toBe("omit");
		expect(req.body).toEqual(sampleScanIn);
	});

	test("scan: 401 then 200 renews the JWT once and resends the same body", async () => {
		const jwt = fakeJwt("old", "new");
		const fetch = fetchSequence(
			errorResponse(401, "unauthenticated"),
			jsonResponse(200, sampleAnalysis),
		);
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		expect(await api.scan(sampleScanIn)).toEqual(sampleAnalysis);
		expect(jwt.invalidate).toHaveBeenCalledTimes(1);
		const retry = requestOf(fetch, 1);
		expect(retry.method).toBe("POST");
		expect(retry.headers.get("authorization")).toBe("Bearer new");
		expect(retry.body).toEqual(sampleScanIn);
		expect(onUnauthenticated).not.toHaveBeenCalled();
	});

	test("scan: two 401 → onUnauthenticated and session_expired", async () => {
		const jwt = fakeJwt("old", "new");
		const fetch = fetchSequence(
			errorResponse(401, "unauthenticated"),
			errorResponse(401, "unauthenticated"),
		);
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		const error = await api.scan(sampleScanIn).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AuthError);
		expect((error as AuthError).code).toBe("session_expired");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
	});

	test("scan: 402 quota_exhausted keeps error details intact", async () => {
		const details = { scanKind: "text", limit: 3, used: 3 };
		const jwt = fakeJwt("jwt-1");
		const fetch = fetchSequence(
			jsonResponse(402, {
				error: { code: "quota_exhausted", message: "Quota épuisé", details },
			}),
		);
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		const error = await api.scan(sampleScanIn).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect((error as ApiRequestError).status).toBe(402);
		expect((error as ApiRequestError).body.error.code).toBe("quota_exhausted");
		expect((error as ApiRequestError).body.error.details).toEqual(details);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(onUnauthenticated).not.toHaveBeenCalled();
	});

	test("scanStream posts to /api/scans/stream with the signal and yields the SSE messages", async () => {
		const jwt = fakeJwt("jwt-1");
		const fetch = fetchSequence(
			sseResponse(
				": ping\n\n",
				sseEvent("stage", { stage: "photos", count: 1 }),
				sseEvent("result", sampleAnalysis),
			),
		);
		const api = createApiClient({ jwt, fetch, onUnauthenticated: vi.fn() });
		const controller = new AbortController();
		const messages = [];
		for await (const m of await api.scanStream(
			sampleScanIn,
			controller.signal,
		)) {
			messages.push(m);
		}
		expect(messages).toEqual([
			{ event: "stage", data: '{"stage":"photos","count":1}' },
			{ event: "result", data: JSON.stringify(sampleAnalysis) },
		]);
		const req = requestOf(fetch);
		expect(req.url).toBe("http://localhost:8080/api/scans/stream");
		expect(req.method).toBe("POST");
		expect(req.headers.get("authorization")).toBe("Bearer jwt-1");
		expect(req.credentials).toBe("omit");
		expect(req.body).toEqual(sampleScanIn);
		expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
	});

	test("scanStream: 401 then stream renews the JWT once; refusals before the stream throw", async () => {
		const jwt = fakeJwt("old", "new", "jwt-2");
		const fetch = fetchSequence(
			errorResponse(401, "unauthenticated"),
			sseResponse(sseEvent("result", sampleAnalysis)),
			jsonResponse(402, {
				error: {
					code: "quota_exhausted",
					message: "Quota épuisé",
					details: {},
				},
			}),
		);
		const onUnauthenticated = vi.fn();
		const api = createApiClient({ jwt, fetch, onUnauthenticated });
		const signal = new AbortController().signal;
		const messages = [];
		for await (const m of await api.scanStream(sampleScanIn, signal)) {
			messages.push(m);
		}
		expect(messages).toHaveLength(1);
		expect(jwt.invalidate).toHaveBeenCalledTimes(1);
		expect(requestOf(fetch, 1).headers.get("authorization")).toBe("Bearer new");
		expect(onUnauthenticated).not.toHaveBeenCalled();

		await expect(api.scanStream(sampleScanIn, signal)).rejects.toMatchObject({
			status: 402,
			body: { error: { code: "quota_exhausted" } },
		});
	});
});
