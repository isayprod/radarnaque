import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, createApi } from "../src/api";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function setup(responses: Response[], tokens: Array<string | null>) {
	const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
		const next = responses.shift();
		if (!next) throw new Error("réponse non prévue");
		return next;
	});
	vi.stubGlobal("fetch", fetchMock);
	const fetchToken = vi.fn(async () => tokens.shift() ?? null);
	const onSignedOut = vi.fn();
	const onForbidden = vi.fn();
	const api = createApi({ fetchToken, onSignedOut, onForbidden });
	return { api, fetchMock, fetchToken, onSignedOut, onForbidden };
}

function bearer(
	fetchMock: ReturnType<typeof setup>["fetchMock"],
	call: number,
) {
	const init = fetchMock.mock.calls[call][1];
	const headers = init?.headers as Record<string, string> | undefined;
	return headers?.authorization;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createApi", () => {
	it("keeps the JWT in memory across requests", async () => {
		const { api, fetchMock, fetchToken } = setup(
			[json({ a: 1 }), json({ a: 2 })],
			["jwt-1"],
		);
		await api.get("/api/admin/x");
		await api.get("/api/admin/y");
		expect(fetchToken).toHaveBeenCalledTimes(1);
		expect(bearer(fetchMock, 1)).toBe("Bearer jwt-1");
	});

	it("sends the JSON body with the method", async () => {
		const { api, fetchMock } = setup([json({ ok: true })], ["jwt-1"]);
		await api.send("PATCH", "/api/admin/users/u1", { plan: "pro" });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/api/admin/users/u1");
		expect(init?.method).toBe("PATCH");
		expect(init?.body).toBe(JSON.stringify({ plan: "pro" }));
	});

	it("returns undefined on 204", async () => {
		const { api } = setup([new Response(null, { status: 204 })], ["jwt-1"]);
		await expect(api.send("DELETE", "/api/admin/users/u1")).resolves.toBe(
			undefined,
		);
	});

	it("retries once with a new token after 401", async () => {
		const { api, fetchMock, fetchToken, onSignedOut } = setup(
			[json({ error: { code: "unauthenticated" } }, 401), json({ ok: 1 })],
			["old", "new"],
		);
		await expect(api.get("/api/admin/x")).resolves.toEqual({ ok: 1 });
		expect(fetchToken).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bearer(fetchMock, 0)).toBe("Bearer old");
		expect(bearer(fetchMock, 1)).toBe("Bearer new");
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it("signs out after a second 401", async () => {
		const { api, fetchMock, onSignedOut } = setup(
			[
				json({ error: { code: "unauthenticated" } }, 401),
				json({ error: { code: "unauthenticated" } }, 401),
			],
			["old", "new"],
		);
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			status: 401,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onSignedOut).toHaveBeenCalledTimes(1);
	});

	it("exposes the details of an API error", async () => {
		const { api } = setup(
			[
				json(
					{
						error: {
							code: "conflict",
							message: "Refusé.",
							details: { reason: "stripe" },
						},
					},
					409,
				),
				json({ error: { code: "conflict" } }, 409),
			],
			["jwt-1"],
		);
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			status: 409,
			details: { reason: "stripe" },
		});
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			details: {},
		});
	});

	it("signs out when no session gives a new token", async () => {
		const { api, onSignedOut } = setup(
			[json({ error: { code: "unauthenticated" } }, 401)],
			["old", null],
		);
		await expect(api.get("/api/admin/x")).rejects.toBeInstanceOf(ApiFailure);
		expect(onSignedOut).toHaveBeenCalledTimes(1);
	});

	it("calls onForbidden on 403 admin_required without retry", async () => {
		const { api, fetchMock, fetchToken, onForbidden, onSignedOut } = setup(
			[json({ error: { code: "admin_required" } }, 403)],
			["jwt-1", "jwt-2"],
		);
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			status: 403,
			code: "admin_required",
		});
		expect(onForbidden).toHaveBeenCalledTimes(1);
		expect(onSignedOut).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchToken).toHaveBeenCalledTimes(1);
	});

	it("rejects other errors with status and code, without side effect", async () => {
		const { api, onForbidden, onSignedOut } = setup(
			[json({ error: { code: "not_found", message: "x", details: {} } }, 404)],
			["jwt-1"],
		);
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});
		expect(onForbidden).not.toHaveBeenCalled();
		expect(onSignedOut).not.toHaveBeenCalled();
	});
	it("keeps the API message on failures, the code when there is none", async () => {
		const { api } = setup(
			[
				json(
					{
						error: {
							code: "conflict",
							message: "Impossible de retirer le dernier admin.",
							details: {},
						},
					},
					409,
				),
				json({ error: { code: "conflict" } }, 409),
			],
			["jwt-1"],
		);
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			message: "Impossible de retirer le dernier admin.",
		});
		await expect(api.get("/api/admin/x")).rejects.toMatchObject({
			message: "conflict",
		});
	});

	describe("concurrent requests", () => {
		const later = () => new Promise((resolve) => setTimeout(resolve, 0));

		// Le faux serveur répond selon le jeton présenté.
		function setupConcurrent(accepted: string[], tokens: Array<string | null>) {
			const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
				const headers = init?.headers as Record<string, string>;
				const token = headers.authorization.replace("Bearer ", "");
				return accepted.includes(token)
					? json({ ok: token })
					: json({ error: { code: "unauthenticated" } }, 401);
			});
			vi.stubGlobal("fetch", fetchMock);
			const fetchToken = vi.fn(async () => {
				await later();
				return tokens.shift() ?? null;
			});
			const onSignedOut = vi.fn();
			const api = createApi({ fetchToken, onSignedOut, onForbidden: vi.fn() });
			return { api, fetchMock, fetchToken, onSignedOut };
		}

		it("asks for one token when the first requests run together", async () => {
			const { api, fetchToken } = setupConcurrent(["jwt-1"], ["jwt-1"]);
			await Promise.all([api.get("/api/admin/a"), api.get("/api/admin/b")]);
			expect(fetchToken).toHaveBeenCalledTimes(1);
		});

		it("renews once when two requests get a 401 together", async () => {
			const { api, fetchToken, onSignedOut } = setupConcurrent(
				["new"],
				["old", "new"],
			);
			const results = await Promise.all([
				api.get("/api/admin/a"),
				api.get("/api/admin/b"),
			]);
			expect(results).toEqual([{ ok: "new" }, { ok: "new" }]);
			// Un jeton initial, un seul renouvellement.
			expect(fetchToken).toHaveBeenCalledTimes(2);
			expect(onSignedOut).not.toHaveBeenCalled();
		});

		it("signs out once when two requests get a second 401 together", async () => {
			const { api, fetchToken, onSignedOut } = setupConcurrent(
				[],
				["old", "new"],
			);
			const results = await Promise.allSettled([
				api.get("/api/admin/a"),
				api.get("/api/admin/b"),
			]);
			expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
			expect(fetchToken).toHaveBeenCalledTimes(2);
			expect(onSignedOut).toHaveBeenCalledTimes(1);
		});
	});
});
