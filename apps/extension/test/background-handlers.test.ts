import type { AnalysisResult, Me, ScanIn } from "@radarnaque/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { adapterFor } from "../lib/adapters/registry";
import {
	type ApiClient,
	ApiRequestError,
	createApiClient,
} from "../lib/api-client";
import { AuthError } from "../lib/auth-client";
import {
	createHandlers,
	createMessageListener,
	guardSender,
	type HandlerDeps,
	handleExternal,
} from "../lib/background-handlers";
import { clearAiResults, createAiResultStore } from "../lib/content/ai-results";
import { createDebugState } from "../lib/debug-state";
import {
	type BgRequest,
	CONTENT_SCRIPT_MESSAGES,
	type ScanRequest,
} from "../lib/messages";
import { createScanPortListener } from "../lib/scan-port";
import type { SseMessage } from "../lib/sse";
import { sessionToken } from "../lib/storage";
import {
	errorResponse,
	fakePort,
	fetchSequence,
	jsonResponse,
	makeJwt,
	sampleAnalysis,
	sse,
	sseEvent,
	sseMessages,
	sseResponse,
	superuserMe,
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
		scanStream: vi.fn<
			(body: ScanIn, signal: AbortSignal) => Promise<AsyncIterable<SseMessage>>
		>(async () => sseMessages(sse("result", sampleAnalysis))),
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
		devBuild: true,
		...overrides,
	};
	return { deps, auth, jwt, api, openPopup, clearAiResults: clear };
}

/**
 * Handlers et port `scan/stream` avec un même état de debug, comme dans
 * `entrypoints/background.ts`. `scan` lance un scan par le port et rend le dernier
 * message posté à l'onglet.
 */
function wire(deps: HandlerDeps, scanApi: Pick<ApiClient, "scanStream">) {
	const debug = createDebugState({
		sessionToken: deps.sessionToken,
		getMe: () => deps.api.getMe(),
		debugLog: deps.debugLog,
		devBuild: deps.devBuild,
	});
	const handle = createHandlers({ ...deps, debug });
	const listener = createScanPortListener({
		api: scanApi,
		allowSender: () => true,
		debug,
	});
	async function scan(request: unknown) {
		const tab = fakePort();
		listener(tab.port);
		tab.send(request);
		return tab.closed();
	}
	return { handle, scan };
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
				features: ["card_icons"],
				unlimited: false,
				debug: false,
				maxImages: 4,
				remaining: { scans: 3 },
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
		trigger: "button",
		partial: false,
		...overrides,
	};
}

describe("scan and popup handlers", () => {
	test("scan/run n'existe plus : unknown_message, sans appel réseau", async () => {
		const { deps, api } = makeDeps();
		expect(
			await createHandlers(deps)({
				type: "scan/run",
				scan: scanRequest(),
			} as unknown as BgRequest),
		).toEqual({ ok: false, error: { code: "unknown_message" } });
		expect(api.scanStream).not.toHaveBeenCalled();
		expect(api.getMe).not.toHaveBeenCalled();
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

/** Faux `console` : tout ce qui y est écrit est inspecté par les tests. */
function fakeConsole() {
	return {
		groupCollapsed: vi.fn<(...args: unknown[]) => void>(),
		log: vi.fn<(...args: unknown[]) => void>(),
		groupEnd: vi.fn<(...args: unknown[]) => void>(),
	};
}

/** Tous les arguments reçus par le faux `console`, sérialisés. */
function written(sink: ReturnType<typeof fakeConsole>): string {
	const calls = [
		...sink.groupCollapsed.mock.calls,
		...sink.log.mock.calls,
		...sink.groupEnd.mock.calls,
	];
	return JSON.stringify(calls);
}

/** Titres et données des groupes écrits, dans l'ordre. */
function groups(sink: ReturnType<typeof fakeConsole>) {
	return sink.groupCollapsed.mock.calls.map(([title], i) => ({
		title,
		data: sink.log.mock.calls[i]?.[0],
	}));
}

const debugAnalysis: AnalysisResult = {
	...sampleAnalysis,
	debug: {
		analysisId: 42,
		contentHash: "c-hash",
		costUsdMicros: 120,
		fromCache: false,
		inputHash: "i-hash",
		llmCalled: true,
		messages: [{ role: "user", content: "Annonce : Vélo" }],
		model: "modele-test",
		promptVersion: { scanKind: "text", version: 1 },
		provider: "fournisseur-test",
		rawResponse: "{}",
		reasoning: "",
		rounds: 1,
		searches: [],
		snapshotId: 7,
		systemPrompt: "Tu analyses une annonce.",
		timingsMs: { images: null, llm: 900, search: null, total: 950 },
		tokensIn: 100,
		tokensOut: 20,
	},
};

describe("content/debug", () => {
	test("superuser : vrai, avec une seule lecture paresseuse de me", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps();
		api.getMe.mockResolvedValue(superuserMe);
		const handle = createHandlers(deps);
		expect(await handle({ type: "content/debug" })).toEqual({
			ok: true,
			data: true,
		});
		expect(await handle({ type: "content/debug" })).toEqual({
			ok: true,
			data: true,
		});
		expect(api.getMe).toHaveBeenCalledTimes(1);
	});

	test("me déjà lu (content/access) : aucune nouvelle lecture", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps();
		api.getMe.mockResolvedValue(superuserMe);
		const handle = createHandlers(deps);
		await handle({ type: "content/access" });
		expect(await handle({ type: "content/debug" })).toEqual({
			ok: true,
			data: true,
		});
		expect(api.getMe).toHaveBeenCalledTimes(1);
	});

	test("compte ordinaire : faux", async () => {
		await sessionToken.setValue("session-abc");
		const { deps } = makeDeps();
		expect(await createHandlers(deps)({ type: "content/debug" })).toEqual({
			ok: true,
			data: false,
		});
	});

	test("sans session : faux, sans appel à getMe", async () => {
		const { deps, api } = makeDeps();
		expect(await createHandlers(deps)({ type: "content/debug" })).toEqual({
			ok: true,
			data: false,
		});
		expect(api.getMe).not.toHaveBeenCalled();
	});

	test("jeton changé depuis la lecture de me : faux jusqu'à la relecture", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps();
		api.getMe.mockResolvedValueOnce(superuserMe).mockResolvedValue(trialMe);
		const handle = createHandlers(deps);
		expect(await handle({ type: "content/debug" })).toEqual({
			ok: true,
			data: true,
		});
		await sessionToken.setValue("session-other");
		expect(await handle({ type: "content/debug" })).toEqual({
			ok: true,
			data: false,
		});
		expect(api.getMe).toHaveBeenCalledTimes(2);
	});

	test("échec de la lecture de me : faux", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps();
		api.getMe.mockRejectedValue(new AuthError("network"));
		expect(await createHandlers(deps)({ type: "content/debug" })).toEqual({
			ok: true,
			data: false,
		});
	});
});

describe("build de production (devBuild: false, R5)", () => {
	test("content/debug d'un compte connecté : faux, sans appel à getMe", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps({ devBuild: false });
		api.getMe.mockResolvedValue(superuserMe);
		expect(await createHandlers(deps)({ type: "content/debug" })).toEqual({
			ok: true,
			data: false,
		});
		expect(api.getMe).not.toHaveBeenCalled();
	});

	test("scan par le port d'un compte connecté : aucune lecture paresseuse de me", async () => {
		await sessionToken.setValue("session-abc");
		const { deps, api } = makeDeps({ devBuild: false });
		expect(await wire(deps, api).scan(scanRequest())).toEqual({
			type: "result",
			result: sampleAnalysis,
		});
		expect(api.scanStream).toHaveBeenCalledTimes(1);
		expect(api.getMe).not.toHaveBeenCalled();
	});
});

describe("superuser debug logs", () => {
	test("superuser : envoi, réception (avec debug) et noCache passent dans les logs", async () => {
		await sessionToken.setValue("session-abc");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		api.getMe.mockResolvedValue(superuserMe);
		api.scanStream.mockImplementation(async () =>
			sseMessages(
				sse("thinking", { part: 1, text: "Je compare les prix." }),
				sse("result", debugAnalysis),
			),
		);
		const { handle, scan } = wire(deps, api);

		expect(await handle({ type: "content/access" })).toMatchObject({
			ok: true,
			data: { status: "active", debug: true },
		});
		expect(sink.groupCollapsed).not.toHaveBeenCalled();

		expect(await scan(scanRequest({ noCache: true }))).toEqual({
			type: "result",
			result: debugAnalysis,
		});
		expect(api.scanStream.mock.calls[0]?.[0]).toMatchObject({ noCache: true });

		const body = api.scanStream.mock.calls[0]?.[0];
		expect(groups(sink)).toEqual([
			{ title: "[Radarnaque debug] scan envoyé", data: body },
			{
				title: "[Radarnaque debug] scan événement",
				data: { type: "thinking", part: 1, text: "Je compare les prix." },
			},
			{
				title: "[Radarnaque debug] scan reçu",
				data: { outcome: "ok", result: debugAnalysis },
			},
		]);
		expect(sink.groupEnd).toHaveBeenCalledTimes(3);
		// Le corps envoyé est déjà nettoyé : pas d'identité du vendeur.
		expect(written(sink)).not.toContain("Jean");
		expect(written(sink)).not.toContain("/u/jean");
	});

	test("superuser : une erreur de scan est journalisée avec son code seul", async () => {
		await sessionToken.setValue("session-abc");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		api.getMe.mockResolvedValue(superuserMe);
		api.scanStream.mockRejectedValueOnce(
			new ApiRequestError(502, {
				error: { code: "analysis_failed", message: "secret", details: {} },
			}),
		);
		const { handle, scan } = wire(deps, api);
		await handle({ type: "auth/state" });
		expect(await scan(scanRequest())).toEqual({
			type: "error",
			code: "analysis_failed",
		});
		expect(groups(sink).map((g) => g.title)).toEqual([
			"[Radarnaque debug] scan envoyé",
			"[Radarnaque debug] scan en erreur",
		]);
		expect(groups(sink)[1]?.data).toEqual({ code: "analysis_failed" });
	});

	test("compte ordinaire, admin ou sans session : aucun log de debug", async () => {
		for (const me of [
			trialMe,
			{ ...trialMe, role: "admin" as const, unlimited: true },
		]) {
			await sessionToken.setValue("session-abc");
			const sink = fakeConsole();
			const { deps, api } = makeDeps({ debugLog: sink });
			api.getMe.mockResolvedValue(me);
			const { handle, scan } = wire(deps, api);
			await handle({ type: "content/access" });
			await scan(scanRequest());
			api.scanStream.mockRejectedValueOnce(new AuthError("network"));
			await scan(scanRequest());
			expect(sink.groupCollapsed).not.toHaveBeenCalled();
			expect(sink.log).not.toHaveBeenCalled();
			expect(sink.groupEnd).not.toHaveBeenCalled();
		}

		// Sans session : aucun `me`, donc aucun log non plus.
		await sessionToken.setValue(null);
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		const { handle, scan } = wire(deps, api);
		await handle({ type: "content/access" });
		await scan(scanRequest());
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});

	test("les logs s'arrêtent dès que le dernier me n'est plus superuser, et à la déconnexion", async () => {
		await sessionToken.setValue("session-abc");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		const { handle, scan } = wire(deps, api);

		api.getMe.mockResolvedValue(superuserMe);
		await handle({ type: "content/access" });
		api.getMe.mockResolvedValue(trialMe);
		await handle({ type: "content/access" });
		await scan(scanRequest());
		expect(sink.groupCollapsed).not.toHaveBeenCalled();

		api.getMe.mockResolvedValue(superuserMe);
		await handle({ type: "auth/state" });
		await handle({ type: "auth/sign-out" });
		await scan(scanRequest());
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});

	test("le log du service worker ne contient jamais le JWT ni le jeton de session", async () => {
		const SESSION = "session-token-tres-secret";
		const JWT = makeJwt(Math.floor(Date.now() / 1000) + 600, "user-su");
		await sessionToken.setValue(SESSION);
		const fetchFn = fetchSequence(
			jsonResponse(200, superuserMe),
			sseResponse(sseEvent("result", debugAnalysis)),
			sseResponse(
				sseEvent("stage", { stage: "analyzing", count: 0 }),
				sseEvent("result", debugAnalysis),
			),
			errorResponse(502, "analysis_failed"),
		);
		const jwt = {
			get: vi.fn<() => Promise<string>>(async () => JWT),
			invalidate: vi.fn(),
		};
		const api = createApiClient({
			jwt,
			fetch: fetchFn,
			onUnauthenticated: async () => {},
		});
		const sink = fakeConsole();
		const { deps } = makeDeps({ api, jwt, debugLog: sink });
		const { handle, scan } = wire(deps, api);

		await handle({ type: "content/access" });
		await scan(scanRequest());
		await scan(scanRequest({ noCache: true }));
		await scan(scanRequest());

		// Le JWT est bien parti dans l'en-tête Authorization…
		expect(
			new Headers(fetchFn.mock.calls[1]?.[1]?.headers).get("authorization"),
		).toBe(`Bearer ${JWT}`);
		// …mais n'apparaît dans aucun argument reçu par la console.
		expect(sink.groupCollapsed).toHaveBeenCalledTimes(7);
		const out = written(sink);
		for (const secret of [
			JWT,
			...JWT.split("."),
			SESSION,
			"Bearer",
			"authorization",
		]) {
			expect(out).not.toContain(secret);
		}
	});
});

describe("superuser debug logs : lié au jeton de session (R3)", () => {
	const PUBLIC = "http://localhost:8080";

	/** Promesse résolue à la main, pour finir un `getMe` au moment voulu. */
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	test("superuser vu, puis nouveau jeton (compte ordinaire) par handleExternal → le scan ne journalise rien", async () => {
		await sessionToken.setValue("session-su");
		const sink = fakeConsole();
		const { deps, api, jwt } = makeDeps({ debugLog: sink });
		const { handle, scan } = wire(deps, api);
		api.getMe.mockResolvedValue(superuserMe);
		await handle({ type: "content/access" });

		expect(
			await handleExternal(
				{ type: "radarnaque/session", token: "session-ordinaire" },
				{ url: `${PUBLIC}/auth/callback` },
				{ publicUrl: PUBLIC, sessionToken, jwt },
			),
		).toEqual({ ok: true });
		api.getMe.mockResolvedValue(trialMe);
		await scan(scanRequest());
		await scan(scanRequest());

		expect(sink.groupCollapsed).not.toHaveBeenCalled();
		// Une seule relecture paresseuse de `me` pour le nouveau jeton.
		expect(api.getMe).toHaveBeenCalledTimes(2);
	});

	test("onUnauthenticated pendant un scan → plus aucun log ensuite", async () => {
		await sessionToken.setValue("session-su");
		const JWT = makeJwt(Math.floor(Date.now() / 1000) + 600, "user-su");
		const fetchFn = fetchSequence(
			jsonResponse(200, superuserMe),
			errorResponse(401, "unauthorized"),
			errorResponse(401, "unauthorized"),
		);
		const jwt = {
			get: vi.fn<() => Promise<string>>(async () => JWT),
			invalidate: vi.fn(),
		};
		const api = createApiClient({
			jwt,
			fetch: fetchFn,
			onUnauthenticated: async () => {
				await sessionToken.setValue(null);
			},
		});
		const sink = fakeConsole();
		const { deps } = makeDeps({ api, jwt, debugLog: sink });
		const { handle, scan } = wire(deps, api);

		await handle({ type: "content/access" });
		expect(await scan(scanRequest())).toEqual({
			type: "error",
			code: "session_expired",
		});
		// L'envoi a eu lieu avec la session ; l'erreur arrive après sa suppression.
		expect(groups(sink).map((g) => g.title)).toEqual([
			"[Radarnaque debug] scan envoyé",
		]);
		await scan(scanRequest());
		expect(sink.groupCollapsed).toHaveBeenCalledTimes(1);
	});

	test("nouveau jeton (non nul) pendant le scan → la réponse n'est pas journalisée", async () => {
		await sessionToken.setValue("session-su");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		api.getMe.mockResolvedValue(superuserMe);
		api.scanStream.mockImplementationOnce(async () => {
			await sessionToken.setValue("session-autre");
			return sseMessages(sse("result", debugAnalysis));
		});
		const { handle, scan } = wire(deps, api);
		await handle({ type: "content/access" });
		await scan(scanRequest());
		expect(groups(sink).map((g) => g.title)).toEqual([
			"[Radarnaque debug] scan envoyé",
		]);
	});

	test("un getMe résolu après une déconnexion est ignoré", async () => {
		await sessionToken.setValue("session-old");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		const { handle, scan } = wire(deps, api);
		const late = deferred<Me>();
		api.getMe.mockReturnValueOnce(late.promise);

		const pending = handle({ type: "content/access" });
		await vi.waitFor(() => expect(api.getMe).toHaveBeenCalledTimes(1));
		await handle({ type: "auth/sign-out" });
		await handle({ type: "auth/verify-otp", email: "a@b.be", otp: "123456" });
		expect(await sessionToken.getValue()).toBe("session-abc");
		late.resolve(superuserMe);
		await pending;

		api.getMe.mockResolvedValue(trialMe);
		await scan(scanRequest());
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
		// Le résultat tardif a été jeté : `me` est relu pour la nouvelle session.
		expect(api.getMe).toHaveBeenCalledTimes(2);
	});

	test("service worker redémarré, jeton superuser : un seul getMe, puis les logs", async () => {
		await sessionToken.setValue("session-su");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		api.getMe.mockResolvedValue(superuserMe);
		const { scan } = wire(deps, api);

		await scan(scanRequest());
		await scan(scanRequest());

		expect(api.getMe).toHaveBeenCalledTimes(1);
		expect(groups(sink).map((g) => g.title)).toEqual([
			"[Radarnaque debug] scan envoyé",
			"[Radarnaque debug] scan reçu",
			"[Radarnaque debug] scan envoyé",
			"[Radarnaque debug] scan reçu",
		]);
	});

	test("service worker redémarré, compte ordinaire : un seul getMe, aucun log", async () => {
		await sessionToken.setValue("session-abc");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		const { scan } = wire(deps, api);

		await scan(scanRequest());
		await scan(scanRequest());

		expect(api.getMe).toHaveBeenCalledTimes(1);
		expect(api.scanStream).toHaveBeenCalledTimes(2);
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});

	test("service worker redémarré, lecture de me en échec : scan fait, aucun log", async () => {
		await sessionToken.setValue("session-su");
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		api.getMe.mockRejectedValueOnce(
			new ApiRequestError(503, {
				error: { code: "auth_unavailable", message: "", details: {} },
			}),
		);
		const { scan } = wire(deps, api);
		expect(await scan(scanRequest())).toEqual({
			type: "result",
			result: sampleAnalysis,
		});
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});

	test("sans session : aucun getMe paresseux", async () => {
		const sink = fakeConsole();
		const { deps, api } = makeDeps({ debugLog: sink });
		await wire(deps, api).scan(scanRequest());
		expect(api.getMe).not.toHaveBeenCalled();
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});

	test("invalid_listing : { code } journalisé pour un superuser, rien pour un compte ordinaire", async () => {
		const malformed = [
			{},
			{ ...scanRequest(), listing: { ...scanRequest().listing, title: " " } },
		];
		for (const [me, expected] of [
			[superuserMe, 2],
			[trialMe, 0],
		] as const) {
			await sessionToken.setValue("session-abc");
			const sink = fakeConsole();
			const { deps, api } = makeDeps({ debugLog: sink });
			api.getMe.mockResolvedValue(me);
			const { handle, scan } = wire(deps, api);
			await handle({ type: "content/access" });
			for (const request of malformed) {
				expect(await scan(request)).toEqual({
					type: "error",
					code: "invalid_listing",
				});
			}
			expect(groups(sink)).toEqual(
				Array.from({ length: expected }, () => ({
					title: "[Radarnaque debug] scan en erreur",
					data: { code: "invalid_listing" },
				})),
			);
			expect(api.scanStream).not.toHaveBeenCalled();
		}
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
			"content/debug",
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
		expect(await guard({ type: "content/debug" }, listingPage)).toEqual({
			ok: true,
			data: "handled",
		});
		expect(handle).toHaveBeenLastCalledWith({ type: "content/debug" });
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
