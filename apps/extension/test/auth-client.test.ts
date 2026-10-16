import { describe, expect, test, vi } from "vitest";
import {
	AuthError,
	fetchJwt,
	signOutRemote,
	startSignIn,
	verifyOtp,
} from "../lib/auth-client";
import {
	errorResponse,
	fetchSequence,
	jsonResponse,
	requestOf,
} from "./helpers";

const BASE = "http://localhost:8080";

async function authErrorCode(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(AuthError);
	return (error as AuthError).code;
}

describe("startSignIn", () => {
	test("posts email and locale to /auth/start", async () => {
		const fetchMock = fetchSequence(jsonResponse(200, { ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		await startSignIn("a@b.be", "nl");
		const req = requestOf(fetchMock);
		expect(req.url).toBe(`${BASE}/auth/start`);
		expect(req.method).toBe("POST");
		expect(req.headers.get("content-type")).toBe("application/json");
		expect(req.body).toEqual({ email: "a@b.be", locale: "nl" });
		expect(req.credentials).toBe("omit");
	});

	test("startSignIn maps 429 → rate_limited, 400 → invalid_email", async () => {
		vi.stubGlobal(
			"fetch",
			fetchSequence(
				errorResponse(429, "rate_limited"),
				errorResponse(400, "invalid_email"),
			),
		);
		expect(await authErrorCode(startSignIn("a@b.be", "fr"))).toBe(
			"rate_limited",
		);
		expect(await authErrorCode(startSignIn("a@b.be", "fr"))).toBe(
			"invalid_email",
		);
	});

	test("network failure and 5xx → network", async () => {
		vi.stubGlobal(
			"fetch",
			fetchSequence(
				new TypeError("Failed to fetch"),
				errorResponse(500, "internal_error"),
			),
		);
		expect(await authErrorCode(startSignIn("a@b.be", "fr"))).toBe("network");
		expect(await authErrorCode(startSignIn("a@b.be", "fr"))).toBe("network");
	});
});

describe("verifyOtp", () => {
	test("verifyOtp returns set-auth-token header; 4xx → AuthError invalid_otp", async () => {
		const fetchMock = fetchSequence(
			jsonResponse(
				200,
				{ token: "ignored", user: { id: "user-1" } },
				{ "set-auth-token": "session-abc" },
			),
			errorResponse(400, "invalid_otp"),
			errorResponse(403, "too_many_attempts"),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await verifyOtp("a@b.be", "123456")).toBe("session-abc");
		const req = requestOf(fetchMock);
		expect(req.url).toBe(`${BASE}/auth/sign-in/email-otp`);
		expect(req.method).toBe("POST");
		expect(req.body).toEqual({ email: "a@b.be", otp: "123456" });
		expect(req.credentials).toBe("omit");

		expect(await authErrorCode(verifyOtp("a@b.be", "000000"))).toBe(
			"invalid_otp",
		);
		expect(await authErrorCode(verifyOtp("a@b.be", "000000"))).toBe(
			"invalid_otp",
		);
	});

	test("200 without set-auth-token, 429 and network failure", async () => {
		vi.stubGlobal(
			"fetch",
			fetchSequence(
				jsonResponse(200, {}),
				errorResponse(429, "rate_limited"),
				new TypeError("Failed to fetch"),
			),
		);
		expect(await authErrorCode(verifyOtp("a@b.be", "123456"))).toBe(
			"invalid_otp",
		);
		expect(await authErrorCode(verifyOtp("a@b.be", "123456"))).toBe(
			"rate_limited",
		);
		expect(await authErrorCode(verifyOtp("a@b.be", "123456"))).toBe("network");
	});
});

describe("fetchJwt", () => {
	test("sends the session token as bearer and returns the JWT", async () => {
		const fetchMock = fetchSequence(jsonResponse(200, { token: "jwt-1" }));
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchJwt("session-abc")).toBe("jwt-1");
		const req = requestOf(fetchMock);
		expect(req.url).toBe(`${BASE}/auth/token`);
		expect(req.method).toBe("GET");
		expect(req.headers.get("authorization")).toBe("Bearer session-abc");
		expect(req.credentials).toBe("omit");
	});

	test("401 → session_expired; 5xx and network failure → network", async () => {
		vi.stubGlobal(
			"fetch",
			fetchSequence(
				errorResponse(401, "unauthorized"),
				errorResponse(503, "unavailable"),
				new TypeError("Failed to fetch"),
			),
		);
		expect(await authErrorCode(fetchJwt("s"))).toBe("session_expired");
		expect(await authErrorCode(fetchJwt("s"))).toBe("network");
		expect(await authErrorCode(fetchJwt("s"))).toBe("network");
	});
});

describe("signOutRemote", () => {
	test("posts to /auth/sign-out with the bearer token", async () => {
		const fetchMock = fetchSequence(jsonResponse(200, { success: true }));
		vi.stubGlobal("fetch", fetchMock);
		await signOutRemote("session-abc");
		const req = requestOf(fetchMock);
		expect(req.url).toBe(`${BASE}/auth/sign-out`);
		expect(req.method).toBe("POST");
		expect(req.headers.get("authorization")).toBe("Bearer session-abc");
	});

	test("ignores network errors and error statuses", async () => {
		vi.stubGlobal(
			"fetch",
			fetchSequence(
				new TypeError("Failed to fetch"),
				errorResponse(401, "unauthorized"),
			),
		);
		await expect(signOutRemote("s")).resolves.toBeUndefined();
		await expect(signOutRemote("s")).resolves.toBeUndefined();
	});
});
