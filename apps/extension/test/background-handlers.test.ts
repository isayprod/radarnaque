import type { AnalysisResult, Me, ScanIn } from "@radarnaque/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { adapterFor } from "../lib/adapters/registry";
import { ApiRequestError, createApiClient } from "../lib/api-client";
import { AuthError } from "../lib/auth-client";
import {
	createHandlers,
	createMessageListener,
	guardSender,
	type HandlerDeps,
	handleExternal,
} from "../lib/background-handlers";
import { clearAiResults, createAiResultStore } from "../lib/content/ai-results";
import {
	type BgRequest,
	CONTENT_SCRIPT_MESSAGES,
	type ScanRequest,
} from "../lib/messages";
import { sessionToken } from "../lib/storage";
import {
	errorResponse,
	fetchSequence,
	sampleAnalysis,
	trialMe,
} from "./helpers";

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
	const api = {
		getMe: vi.fn<() => Promise<Me>>(async () => trialMe),
		scan: vi.fn<(body: ScanIn) => Promise<AnalysisResult>>(
			async () => sampleAnalysis,
		),
	};
	const openPopup = vi.fn<() => Promise<void>>(async () => {});
	const clear = vi.fn<() => Promise<void>>(async () => {});
	const deps: HandlerDeps = {
		sessionToken,
		auth,
		jwt,
		api,
		openPopup,
		clearAiResults: clear,
		...overrides,
	};
	return { deps, auth, jwt, api, openPopup, clearAiResults: clear };
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

	test("R5 : sign-out vide les résultats IA gardés (local:aiResults)", async () => {
		await sessionToken.setValue("session-abc");
		const results = createAiResultStore();
		await results.put("2ememain.be", "m1", {
			result: { ...sampleAnalysis, analyzedAt: new Date().toISOString() },
			scanKind: "text",
			fingerprint: "fp",
			storedAt: Date.now(),
		});
		expect(await fakeBrowser.storage.local.get("aiResults")).toHaveProperty(
			"aiResults",
		);
		const { deps } = makeDeps({ clearAiResults });
		expect(await createHandlers(deps)({ type: "auth/sign-out" })).toEqual({
			ok: true,
			data: null,
		});
		expect(await fakeBrowser.storage.local.get("aiResults")).toEqual({});
		expect(await createAiResultStore().get("2ememain.be", "m1")).toBeNull();
	});

	test("R5 : un échec du vidage ne bloque pas la déconnexion", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, clearAiResults: clear, jwt } = makeDeps();
		clear.mockRejectedValueOnce(new Error("indisponible"));
		expect(await createHandlers(deps)({ type: "auth/sign-out" })).toEqual({
			ok: true,
			data: null,
		});
		expect(clear).toHaveBeenCalledTimes(1);
		expect(await sessionToken.getValue()).toBeNull();
		expect(jwt.invalidate).toHaveBeenCalled();
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

	test("content/access without token → signedOut, no getMe", async () => {
		const { deps, api } = makeDeps();
		expect(await createHandlers(deps)({ type: "content/access" })).toEqual({
			ok: true,
			data: { status: "signedOut" },
		});
		expect(api.getMe).not.toHaveBeenCalled();
	});

	test("content/access with a session → access computed from me", async () => {
		await sessionToken.setValue("session-abc");
		const { deps } = makeDeps();
		expect(await createHandlers(deps)({ type: "content/access" })).toEqual({
			ok: true,
			data: {
				status: "active",
				features: ["card_icons", "image_scan"],
				unlimited: false,
				remaining: { text: 3, image: 3, total: 3 },
			},
		});
	});

	test("content/access: expired session → signedOut; 503 → auth_unavailable", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps();
		const handle = createHandlers(deps);
		api.getMe.mockRejectedValueOnce(new AuthError("session_expired"));
		expect(await handle({ type: "content/access" })).toEqual({
			ok: true,
			data: { status: "signedOut" },
		});
		api.getMe.mockRejectedValueOnce(
			new ApiRequestError(503, {
				error: { code: "auth_unavailable", message: "", details: {} },
			}),
		);
		expect(await handle({ type: "content/access" })).toEqual({
			ok: false,
			error: { code: "auth_unavailable" },
		});
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

function scanRequest(overrides: Partial<ScanRequest> = {}): ScanRequest {
	return {
		listing: {
			site: "2ememain.be",
			externalId: "m123",
			url: "https://www.2ememain.be/v/velo/m123",
			title: "Vélo",
			description: "Bon état.",
			price: { amountCents: 15000, currency: "EUR" },
			priceType: "fixed",
			location: { city: "Namur" },
			images: [],
			seller: { id: "77", name: "Jean", profileUrl: "/u/jean", reviewCount: 4 },
		},
		signals: [{ id: "no_reviews", weight: 10, severity: "warning" }],
		rulesVersion: 2,
		scanKind: "text",
		trigger: "button",
		partial: false,
		...overrides,
	};
}

describe("scan and popup handlers", () => {
	test("scan/run: success → ok(result), body sent without seller identity", async () => {
		const { deps, api } = makeDeps();
		expect(
			await createHandlers(deps)({ type: "scan/run", scan: scanRequest() }),
		).toEqual({ ok: true, data: sampleAnalysis });
		expect(api.scan).toHaveBeenCalledTimes(1);
		const body = api.scan.mock.calls[0]?.[0];
		expect(body?.listing.seller).toEqual({ reviewCount: 4 });
		expect(body?.rules).toEqual({
			version: 2,
			signals: [{ id: "no_reviews", weight: 10, severity: "warning" }],
		});
	});

	test("scan/run: API and auth errors are mapped to their code", async () => {
		const { deps, api } = makeDeps();
		const handle = createHandlers(deps);
		const run = () => handle({ type: "scan/run", scan: scanRequest() });
		api.scan.mockRejectedValueOnce(
			new ApiRequestError(502, {
				error: { code: "analysis_failed", message: "", details: {} },
			}),
		);
		expect(await run()).toEqual({
			ok: false,
			error: { code: "analysis_failed" },
		});
		api.scan.mockRejectedValueOnce(new AuthError("session_expired"));
		expect(await run()).toEqual({
			ok: false,
			error: { code: "session_expired" },
		});
		api.scan.mockRejectedValueOnce(new AuthError("network"));
		expect(await run()).toEqual({ ok: false, error: { code: "network" } });
	});

	test("scan/run: empty title → invalid_listing without network call", async () => {
		const { deps, api } = makeDeps();
		const scan = scanRequest();
		scan.listing.title = "   ";
		expect(await createHandlers(deps)({ type: "scan/run", scan })).toEqual({
			ok: false,
			error: { code: "invalid_listing" },
		});
		expect(api.scan).not.toHaveBeenCalled();
	});

	test("scan/run: malformed request → invalid_listing without network call", async () => {
		const { deps, api } = makeDeps();
		const handle = createHandlers(deps);
		for (const scan of [undefined, null, "scan", 3, {}, { listing: null }]) {
			expect(
				await handle({ type: "scan/run", scan } as unknown as BgRequest),
			).toEqual({ ok: false, error: { code: "invalid_listing" } });
		}
		expect(api.scan).not.toHaveBeenCalled();
	});

	test("ui/open-popup opens the popup; a rejection → popup_unavailable", async () => {
		const { deps, openPopup } = makeDeps();
		const handle = createHandlers(deps);
		expect(await handle({ type: "ui/open-popup" })).toEqual({
			ok: true,
			data: null,
		});
		expect(openPopup).toHaveBeenCalledTimes(1);
		openPopup.mockRejectedValueOnce(new Error("no active window"));
		expect(await handle({ type: "ui/open-popup" })).toEqual({
			ok: false,
			error: { code: "popup_unavailable" },
		});
	});
});

describe("sender check", () => {
	const self = {
		id: "abcdefghijklmnopabcdefghijklmnop",
		baseUrl: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
	};
	const popup = { id: self.id, url: `${self.baseUrl}popup.html` };
	const tab = { id: 1, index: 0 };
	const listingPage = {
		id: self.id,
		url: "https://www.2ememain.be/v/x/m1",
		tab,
	};
	const forbidden = { ok: false, error: { code: "forbidden_sender" } };
	const AUTH_MESSAGES: BgRequest[] = [
		{ type: "auth/start", email: "a@b.be", locale: "fr" },
		{ type: "auth/verify-otp", email: "a@b.be", otp: "123456" },
		{ type: "auth/state" },
		{ type: "auth/sign-out" },
	];

	function guarded() {
		const handle = vi.fn(async (_req: BgRequest) => ({
			ok: true as const,
			data: "handled",
		}));
		return {
			handle,
			guard: guardSender(handle, self, (url) => adapterFor(url) !== null),
		};
	}

	test("the content script allow-list is exactly the three content messages", () => {
		expect([...CONTENT_SCRIPT_MESSAGES].sort()).toEqual([
			"content/access",
			"scan/run",
			"ui/open-popup",
		]);
	});

	test("a popup-like sender (own id, extension page, no tab) is accepted for every message", async () => {
		const { handle, guard } = guarded();
		for (const req of [
			...AUTH_MESSAGES,
			{ type: "content/access" },
		] as BgRequest[]) {
			expect(await guard(req, popup)).toEqual({ ok: true, data: "handled" });
			expect(handle).toHaveBeenLastCalledWith(req);
		}
	});

	test("a content script on a supported site may send the content messages", async () => {
		const { handle, guard } = guarded();
		expect(await guard({ type: "content/access" }, listingPage)).toEqual({
			ok: true,
			data: "handled",
		});
		expect(handle).toHaveBeenCalledWith({ type: "content/access" });
		expect(
			await guard(
				{ type: "ui/open-popup" },
				{
					...listingPage,
					url: "https://www.facebook.com/marketplace/item/1/",
				},
			),
		).toEqual({ ok: true, data: "handled" });
		expect(handle).toHaveBeenCalledTimes(2);
	});

	test("a content script on a supported site may not send auth messages", async () => {
		const { handle, guard } = guarded();
		for (const req of AUTH_MESSAGES) {
			expect(await guard(req, listingPage)).toEqual(forbidden);
		}
		for (const req of [{ type: "nope" }, null, "content/access"]) {
			expect(await guard(req as BgRequest, listingPage)).toEqual(forbidden);
		}
		expect(handle).not.toHaveBeenCalled();
	});

	test("content messages from an unsupported page, a foreign id or without tab are rejected", async () => {
		const { handle, guard } = guarded();
		for (const sender of [
			{ ...listingPage, url: "https://evil.example/" },
			{ ...listingPage, url: "https://www.2ememain.be.evil.com/v/x/m1" },
			{ ...listingPage, url: "pas une url" },
			{ id: self.id, tab },
			{ ...listingPage, id: "ponmlkjihgfedcbaponmlkjihgfedcba" },
			{ url: listingPage.url, tab },
			{ id: self.id, url: listingPage.url },
		]) {
			expect(await guard({ type: "content/access" }, sender)).toEqual(
				forbidden,
			);
		}
		expect(handle).not.toHaveBeenCalled();
	});

	test("an extension page inside a tab is not a popup", async () => {
		const { handle, guard } = guarded();
		for (const sender of [
			{ ...popup, tab },
			{ id: self.id, url: "https://evil.example/", tab },
		]) {
			expect(await guard({ type: "auth/sign-out" }, sender)).toEqual(forbidden);
		}
		expect(handle).not.toHaveBeenCalled();
	});

	test("an extension page inside a tab may not send content messages either", async () => {
		const { handle, guard } = guarded();
		expect(await guard({ type: "content/access" }, { ...popup, tab })).toEqual(
			forbidden,
		);
		expect(handle).not.toHaveBeenCalled();
	});

	test("a foreign extension id or a non-extension page is rejected", async () => {
		const { handle, guard } = guarded();
		for (const sender of [
			{ ...popup, id: "ponmlkjihgfedcbaponmlkjihgfedcba" },
			{ url: popup.url },
			{ id: self.id, url: "https://evil.example/popup.html" },
			{
				id: self.id,
				url: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/popup.html",
			},
			{ id: self.id },
		]) {
			expect(await guard({ type: "auth/state" }, sender)).toEqual(forbidden);
		}
		expect(handle).not.toHaveBeenCalled();
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
