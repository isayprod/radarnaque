import type { Me } from "@radarnaque/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createApiClient } from "../lib/api-client";
import { AuthError } from "../lib/auth-client";
import {
	createHandlers,
	createMessageListener,
	type HandlerDeps,
	handleExternal,
} from "../lib/background-handlers";
import type { BgRequest } from "../lib/messages";
import { sessionToken } from "../lib/storage";
import { errorResponse, fetchSequence, trialMe } from "./helpers";

const PUBLIC_URL = "http://localhost:8080";

function makeDeps(overrides: Partial<HandlerDeps> = {}) {
	const auth = {
		startSignIn: vi.fn<(email: string, locale: "fr" | "nl") => Promise<void>>(
			async () => {},
		),
		verifyOtp: vi.fn<(email: string, otp: string) => Promise<string>>(
			async () => "session-abc",
		),
		signOutRemote: vi.fn<(token: string) => Promise<void>>(async () => {}),
	};
	const jwt = { get: vi.fn<() => Promise<string>>(), invalidate: vi.fn() };
	const api = { getMe: vi.fn<() => Promise<Me>>(async () => trialMe) };
	const deps: HandlerDeps = { sessionToken, auth, jwt, api, ...overrides };
	return { deps, auth, jwt, api };
}

beforeEach(() => {
	fakeBrowser.reset();
});

describe("background handlers", () => {
	test("handlers: verify-otp stores token; state returns signedIn with me; sign-out clears token", async () => {
		const { deps, auth, jwt, api } = makeDeps();
		const handle = createHandlers(deps);

		expect(
			await handle({
				type: "auth/verify-otp",
				email: "  A@B.BE ",
				otp: "123456",
			}),
		).toEqual({ ok: true, data: null });
		expect(auth.verifyOtp).toHaveBeenCalledWith("a@b.be", "123456");
		expect(await sessionToken.getValue()).toBe("session-abc");
		expect(jwt.invalidate).toHaveBeenCalled();

		expect(await handle({ type: "auth/state" })).toEqual({
			ok: true,
			data: { status: "signedIn", me: trialMe },
		});
		expect(api.getMe).toHaveBeenCalledTimes(1);

		jwt.invalidate.mockClear();
		expect(await handle({ type: "auth/sign-out" })).toEqual({
			ok: true,
			data: null,
		});
		expect(auth.signOutRemote).toHaveBeenCalledWith("session-abc");
		expect(await sessionToken.getValue()).toBeNull();
		expect(jwt.invalidate).toHaveBeenCalled();
	});

	test("sign-out clears the session even if the remote call fails", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, auth } = makeDeps();
		auth.signOutRemote.mockRejectedValueOnce(new Error("boom"));
		expect(await createHandlers(deps)({ type: "auth/sign-out" })).toEqual({
			ok: true,
			data: null,
		});
		expect(await sessionToken.getValue()).toBeNull();
	});

	test("handlers: state without token → signedOut, no network call", async () => {
		const fetch = fetchSequence();
		vi.stubGlobal("fetch", fetch);
		const { deps, api } = makeDeps();
		expect(await createHandlers(deps)({ type: "auth/state" })).toEqual({
			ok: true,
			data: { status: "signedOut" },
		});
		expect(api.getMe).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("state: expired session → signedOut; other errors keep the session", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps();
		const handle = createHandlers(deps);
		api.getMe.mockRejectedValueOnce(new AuthError("network"));
		expect(await handle({ type: "auth/state" })).toEqual({
			ok: false,
			error: { code: "network" },
		});
		api.getMe.mockRejectedValueOnce(new AuthError("session_expired"));
		expect(await handle({ type: "auth/state" })).toEqual({
			ok: true,
			data: { status: "signedOut" },
		});
	});

	test("state: 503 auth_unavailable keeps the session token stored", async () => {
		await sessionToken.setValue("session-abc");
		const jwt = {
			get: vi.fn(async () => "jwt-1"),
			invalidate: vi.fn(),
		};
		const onUnauthenticated = vi.fn(async () => {
			await sessionToken.setValue(null);
		});
		const api = createApiClient({
			jwt,
			fetch: fetchSequence(errorResponse(503, "auth_unavailable")),
			onUnauthenticated,
		});
		const { deps } = makeDeps({ api, jwt });
		expect(await createHandlers(deps)({ type: "auth/state" })).toEqual({
			ok: false,
			error: { code: "auth_unavailable" },
		});
		expect(onUnauthenticated).not.toHaveBeenCalled();
		expect(jwt.invalidate).not.toHaveBeenCalled();
		expect(await sessionToken.getValue()).toBe("session-abc");
	});

	test("start and verify-otp normalize and validate the email before any network call", async () => {
		const { deps, auth } = makeDeps();
		const handle = createHandlers(deps);

		expect(
			await handle({ type: "auth/start", email: " A@B.BE ", locale: "nl" }),
		).toEqual({ ok: true, data: null });
		expect(auth.startSignIn).toHaveBeenCalledWith("a@b.be", "nl");

		for (const req of [
			{ type: "auth/start", email: "pas-un-email", locale: "fr" },
			{ type: "auth/verify-otp", email: "a@", otp: "123456" },
		] as BgRequest[]) {
			expect(await handle(req)).toEqual({
				ok: false,
				error: { code: "invalid_email" },
			});
		}
		expect(auth.startSignIn).toHaveBeenCalledTimes(1);
		expect(auth.verifyOtp).not.toHaveBeenCalled();
	});

	test("verify-otp: malformed code → invalid_otp without network; auth errors are mapped", async () => {
		const { deps, auth } = makeDeps();
		const handle = createHandlers(deps);
		expect(
			await handle({ type: "auth/verify-otp", email: "a@b.be", otp: "12a" }),
		).toEqual({ ok: false, error: { code: "invalid_otp" } });
		expect(auth.verifyOtp).not.toHaveBeenCalled();

		auth.verifyOtp.mockRejectedValueOnce(new AuthError("invalid_otp"));
		expect(
			await handle({
				type: "auth/verify-otp",
				email: "a@b.be",
				otp: " 123456 ",
			}),
		).toEqual({ ok: false, error: { code: "invalid_otp" } });
		expect(auth.verifyOtp).toHaveBeenCalledWith("a@b.be", "123456");
		expect(await sessionToken.getValue()).toBeNull();

		auth.startSignIn.mockRejectedValueOnce(new AuthError("rate_limited"));
		expect(
			await handle({ type: "auth/start", email: "a@b.be", locale: "fr" }),
		).toEqual({ ok: false, error: { code: "rate_limited" } });
	});

	test("unknown message types are rejected", async () => {
		const { deps } = makeDeps();
		const handle = createHandlers(deps);
		for (const message of [
			{ type: "auth/nope" },
			{ nothing: true },
			null,
			"auth/state",
		]) {
			expect(await handle(message as BgRequest)).toEqual({
				ok: false,
				error: { code: "unknown_message" },
			});
		}
	});

	test("message listener answers asynchronously through sendResponse", async () => {
		const { deps } = makeDeps();
		const listener = createMessageListener(createHandlers(deps));
		const sendResponse = vi.fn();
		const keepOpen = listener({ type: "auth/state" }, {}, sendResponse);
		expect(keepOpen).toBe(true);
		await vi.waitFor(() =>
			expect(sendResponse).toHaveBeenCalledWith({
				ok: true,
				data: { status: "signedOut" },
			}),
		);
	});
});

describe("external messages", () => {
	function externalDeps() {
		const jwt = { invalidate: vi.fn() };
		return { deps: { publicUrl: PUBLIC_URL, sessionToken, jwt }, jwt };
	}

	test("external message from PUBLIC_URL stores token", async () => {
		const { deps, jwt } = externalDeps();
		expect(
			await handleExternal(
				{ type: "radarnaque/session", token: "session-from-link" },
				{ url: `${PUBLIC_URL}/auth/callback` },
				deps,
			),
		).toEqual({ ok: true });
		expect(await sessionToken.getValue()).toBe("session-from-link");
		expect(jwt.invalidate).toHaveBeenCalled();
	});

	test("external message from other origin or malformed payload is refused", async () => {
		const { deps } = externalDeps();
		const good = { type: "radarnaque/session", token: "t" };
		const cases: Array<[unknown, { url?: string }]> = [
			[good, { url: "https://evil.example/auth/callback" }],
			[good, { url: "http://localhost:9999/auth/callback" }],
			[good, { url: "https://localhost:8080/auth/callback" }],
			[good, {}],
			[good, { url: "pas une url" }],
			[{ type: "radarnaque/session", token: "" }, { url: PUBLIC_URL }],
			[{ type: "radarnaque/session", token: 42 }, { url: PUBLIC_URL }],
			[{ type: "session", token: "t" }, { url: PUBLIC_URL }],
			[null, { url: PUBLIC_URL }],
		];
		for (const [message, sender] of cases) {
			expect(await handleExternal(message, sender, deps)).toEqual({
				ok: false,
			});
		}
		expect(await sessionToken.getValue()).toBeNull();
	});
});
