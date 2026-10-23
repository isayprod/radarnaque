import type { ScanIn } from "@radarnaque/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { adapterFor } from "../lib/adapters/registry";
import { ApiRequestError } from "../lib/api-client";
import { AuthError } from "../lib/auth-client";
import {
	type InternalSender,
	portSenderGuard,
} from "../lib/background-handlers";
import type { ScanDebugHooks } from "../lib/debug-state";
import type { ScanRequest } from "../lib/messages";
import {
	createScanPortListener,
	KEEP_ALIVE_MS,
	SCAN_PORT,
} from "../lib/scan-port";
import type { SseMessage } from "../lib/sse";
import {
	fakePort,
	sampleAnalysis,
	sampleIdentification,
	sse,
	sseMessages,
} from "./helpers";

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

/** Flux qui ne finit jamais : il ne s'arrête qu'avec le signal d'annulation. */
async function* endless(signal: AbortSignal): AsyncIterable<SseMessage> {
	yield sse("stage", { stage: "analyzing", count: 0 });
	await new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason));
	});
}

function setup(
	stream: (signal: AbortSignal) => AsyncIterable<SseMessage> = () =>
		sseMessages(sse("result", sampleAnalysis)),
	options: {
		timeoutMs?: number;
		allowSender?: (sender: InternalSender | undefined) => boolean;
	} = {},
) {
	const scanStream = vi.fn(async (_body: ScanIn, signal: AbortSignal) =>
		stream(signal),
	);
	const identifyStream = vi.fn(async (_body: ScanIn, signal: AbortSignal) =>
		stream(signal),
	);
	const debug: ScanDebugHooks = {
		ensureKnown: vi.fn(async () => {}),
		group: vi.fn(async () => {}),
	};
	const keepAlive = vi.fn(async () => ({ os: "linux" }));
	const listener = createScanPortListener({
		api: { scanStream, identifyStream },
		allowSender: options.allowSender ?? (() => true),
		debug,
		timeoutMs: options.timeoutMs,
		keepAlive,
	});
	return { scanStream, identifyStream, debug, keepAlive, listener };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("port scan/stream", () => {
	test("relays events then result and disconnects", async () => {
		const { listener, scanStream } = setup(() =>
			sseMessages(
				sse("stage", { stage: "photos", count: 2 }),
				sse("thinking", { part: 1, text: "Je vérifie le prix." }),
				sse("search", { id: 1, query: "prix vélo", aspect: "price" }),
				{ event: "noise", data: "{}" },
				sse("search_done", { id: 1, ok: true, count: 5, domains: ["a.be"] }),
				sse("stage", { stage: "writing" }),
				sse("result", sampleAnalysis),
				sse("stage", { stage: "cache" }),
			),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		expect(await tab.closed()).toEqual({
			type: "result",
			result: sampleAnalysis,
		});
		expect(tab.posted).toEqual([
			{ type: "event", event: { type: "stage", stage: "photos", count: 2 } },
			{
				type: "event",
				event: { type: "thinking", part: 1, text: "Je vérifie le prix." },
			},
			{
				type: "event",
				event: { type: "search", id: 1, query: "prix vélo", aspect: "price" },
			},
			{
				type: "event",
				event: {
					type: "search_done",
					id: 1,
					ok: true,
					count: 5,
					domains: ["a.be"],
				},
			},
			{ type: "event", event: { type: "stage", stage: "writing" } },
			{ type: "result", result: sampleAnalysis },
		]);
		expect(scanStream).toHaveBeenCalledTimes(1);
		expect(tab.port.disconnect).toHaveBeenCalledTimes(1);
	});

	test("rejects unknown port name", () => {
		const { listener, scanStream, debug } = setup();
		const tab = fakePort("scan/run");
		listener(tab.port);
		expect(tab.port.disconnect).toHaveBeenCalledTimes(1);
		tab.send(scanRequest());
		expect(scanStream).not.toHaveBeenCalled();
		expect(debug.ensureKnown).not.toHaveBeenCalled();
		expect(tab.posted).toEqual([]);
	});

	test("rejects sender off supported site", () => {
		const self = {
			id: "abcdefghijklmnopabcdefghijklmnop",
			baseUrl: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
		};
		const allowSender = portSenderGuard(
			self,
			(url) => adapterFor(url) !== null,
		);
		const { listener, scanStream } = setup(undefined, { allowSender });
		const tab = { id: 1, index: 0 };
		for (const sender of [
			{ id: self.id, url: "https://evil.example/", tab },
			{
				id: "ponmlkjihgfedcbaponmlkjihgfedcba",
				url: "https://www.2ememain.be/v/x/m1",
				tab,
			},
			{ id: self.id, url: "https://www.2ememain.be/v/x/m1" },
			undefined,
		]) {
			const port = fakePort(SCAN_PORT, sender);
			listener(port.port);
			expect(port.port.disconnect).toHaveBeenCalledTimes(1);
			port.send(scanRequest());
		}
		expect(scanStream).not.toHaveBeenCalled();

		// Un content script d'un site pris en charge est accepté.
		const ok = fakePort(SCAN_PORT, {
			id: self.id,
			url: "https://www.2ememain.be/v/x/m1",
			tab,
		});
		listener(ok.port);
		expect(ok.port.disconnect).not.toHaveBeenCalled();
	});

	test("only the first message starts a scan", async () => {
		const { listener, scanStream } = setup();
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		tab.send(scanRequest({ trigger: "card" }));
		await tab.closed();
		tab.send(scanRequest());
		expect(scanStream).toHaveBeenCalledTimes(1);
		expect(scanStream.mock.calls[0]?.[0].trigger).toBe("button");
	});

	test("aborts fetch when the tab disconnects", async () => {
		const { listener, scanStream } = setup((signal) => endless(signal));
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await vi.waitFor(() => expect(tab.posted).toHaveLength(1));
		const signal = scanStream.mock.calls[0]?.[1];
		expect(signal?.aborted).toBe(false);
		tab.close();
		expect(signal?.aborted).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		// Le port est fermé par l'onglet : rien n'est plus posté.
		expect(tab.posted).toHaveLength(1);
	});

	test("posts stream_interrupted when stream ends without result", async () => {
		const { listener } = setup(() =>
			sseMessages(sse("stage", { stage: "analyzing", count: 1 })),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		expect(await tab.closed()).toEqual({
			type: "error",
			code: "stream_interrupted",
		});
	});

	test("a network failure while reading → stream_interrupted", async () => {
		const { listener } = setup(async function* () {
			yield sse("stage", { stage: "photos", count: 1 });
			throw new TypeError("network error");
		});
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		expect(await tab.closed()).toEqual({
			type: "error",
			code: "stream_interrupted",
		});
	});

	test("posts timeout after timeoutMs", async () => {
		vi.useFakeTimers();
		const { listener, scanStream } = setup((signal) => endless(signal), {
			timeoutMs: 1000,
		});
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await vi.advanceTimersByTimeAsync(999);
		expect(tab.port.disconnect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(scanStream.mock.calls[0]?.[1].aborted).toBe(true);
		expect(tab.posted.at(-1)).toEqual({ type: "error", code: "timeout" });
		expect(tab.port.disconnect).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10);
		expect(tab.posted.filter((m) => m.type === "error")).toHaveLength(1);
	});

	test("times out after SCAN_TIMEOUT_MS = 310 000", async () => {
		vi.useFakeTimers();
		const { listener } = setup((signal) => endless(signal));
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await vi.advanceTimersByTimeAsync(309_999);
		expect(tab.port.disconnect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(tab.posted.at(-1)).toEqual({ type: "error", code: "timeout" });
	});

	test("routes purpose identify to identifyStream", async () => {
		const { listener, scanStream, identifyStream } = setup(() =>
			sseMessages(
				sse("stage", { stage: "reading_photos" }),
				sse("result", sampleIdentification),
			),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest({ purpose: "identify" }));
		expect(await tab.closed()).toEqual({
			type: "result",
			result: sampleIdentification,
		});
		expect(scanStream).not.toHaveBeenCalled();
		expect(identifyStream).toHaveBeenCalledTimes(1);
		// `purpose` ne part pas à l'API (ScanIn refuse les champs en trop).
		expect(identifyStream.mock.calls[0]?.[0]).not.toHaveProperty("purpose");
		expect(tab.posted[0]).toEqual({
			type: "event",
			event: { type: "stage", stage: "reading_photos" },
		});
	});

	test("routes a request without purpose to scanStream", async () => {
		const { listener, scanStream, identifyStream } = setup();
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await tab.closed();
		expect(scanStream).toHaveBeenCalledTimes(1);
		expect(identifyStream).not.toHaveBeenCalled();
	});

	test("routes an unknown purpose to scanStream", async () => {
		const { listener, scanStream, identifyStream } = setup();
		const tab = fakePort();
		listener(tab.port);
		tab.send({ ...scanRequest(), purpose: "bogus" });
		await tab.closed();
		expect(scanStream).toHaveBeenCalledTimes(1);
		expect(identifyStream).not.toHaveBeenCalled();
	});

	test("maps ApiRequestError 402 to quota_exhausted", async () => {
		const { listener, scanStream } = setup();
		scanStream.mockRejectedValueOnce(
			new ApiRequestError(402, {
				error: {
					code: "quota_exhausted",
					message: "Quota épuisé",
					details: {},
				},
			}),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		expect(await tab.closed()).toEqual({
			type: "error",
			code: "quota_exhausted",
		});
		expect(tab.posted).toHaveLength(1);
	});

	test("auth errors keep their code, as with scan/run", async () => {
		for (const code of ["session_expired", "network"] as const) {
			const { listener, scanStream } = setup();
			scanStream.mockRejectedValueOnce(new AuthError(code));
			const tab = fakePort();
			listener(tab.port);
			tab.send(scanRequest());
			expect(await tab.closed()).toEqual({ type: "error", code });
		}
	});

	test("the error event of the stream keeps its code", async () => {
		const { listener } = setup(() =>
			sseMessages(
				sse("stage", { stage: "analyzing", count: 0 }),
				sse("error", {
					code: "analysis_failed",
					message: "L'analyse a échoué.",
					details: { reason: "timeout" },
				}),
			),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		expect(await tab.closed()).toEqual({
			type: "error",
			code: "analysis_failed",
		});
	});

	test("an invalid result → invalid_response", async () => {
		const { score: _, ...withoutScore } = sampleAnalysis;
		const { listener } = setup(() => sseMessages(sse("result", withoutScore)));
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		expect(await tab.closed()).toEqual({
			type: "error",
			code: "invalid_response",
		});
	});

	test("strips seller identity via toScanIn", async () => {
		const { listener, scanStream } = setup();
		const tab = fakePort();
		listener(tab.port);
		tab.send({ ...scanRequest({ noCache: true }), scanKind: "image" });
		await tab.closed();
		const body = scanStream.mock.calls[0]?.[0];
		expect(body?.listing.seller).toEqual({ reviewCount: 4 });
		const json = JSON.stringify(body);
		expect(json).not.toContain("Jean");
		expect(json).not.toContain("/u/jean");
		expect(body).not.toHaveProperty("scanKind");
		expect(body).toMatchObject({
			noCache: true,
			trigger: "button",
			partial: false,
		});
		expect(body?.rules).toEqual({
			version: 2,
			signals: [{ id: "no_reviews", weight: 10, severity: "warning" }],
		});
	});

	test("malformed request or empty title → invalid_listing without network call", async () => {
		const { listener, scanStream } = setup();
		const empty = scanRequest();
		empty.listing.title = "   ";
		for (const message of [
			undefined,
			null,
			"scan",
			3,
			{},
			{ listing: null },
			empty,
		]) {
			const tab = fakePort();
			listener(tab.port);
			tab.send(message);
			expect(await tab.closed()).toEqual({
				type: "error",
				code: "invalid_listing",
			});
		}
		expect(scanStream).not.toHaveBeenCalled();
	});

	test("debug : envoyé, chaque événement, reçu ; en erreur avec le code seul", async () => {
		const { listener, debug, scanStream } = setup(() =>
			sseMessages(
				sse("search", { id: 1, query: "prix vélo", aspect: "price" }),
				sse("result", sampleAnalysis),
			),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await tab.closed();
		const body = scanStream.mock.calls[0]?.[0];
		expect(debug.ensureKnown).toHaveBeenCalledTimes(1);
		expect(vi.mocked(debug.group).mock.calls).toEqual([
			["scan envoyé", body],
			[
				"scan événement",
				{ type: "search", id: 1, query: "prix vélo", aspect: "price" },
			],
			["scan reçu", { outcome: "ok", result: sampleAnalysis }],
		]);

		scanStream.mockRejectedValueOnce(
			new ApiRequestError(502, {
				error: { code: "analysis_failed", message: "secret", details: {} },
			}),
		);
		vi.mocked(debug.group).mockClear();
		const failing = fakePort();
		listener(failing.port);
		failing.send(scanRequest());
		await failing.closed();
		expect(vi.mocked(debug.group).mock.calls).toEqual([
			["scan envoyé", body],
			["scan en erreur", { code: "analysis_failed" }],
		]);
	});

	test("keepAlive every 20 s during a silent stream, then never after the end", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const { listener, keepAlive } = setup(async function* () {
			yield sse("stage", { stage: "analyzing", count: 0 });
			// Tour du modèle silencieux : seuls des `: ping` arriveraient, jetés par readSse.
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			yield sse("result", sampleAnalysis);
		});
		const tab = fakePort();
		listener(tab.port);
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
		// Pas de battement avant le message de départ.
		expect(keepAlive).not.toHaveBeenCalled();
		tab.send(scanRequest());
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 4);
		expect(keepAlive).toHaveBeenCalledTimes(4);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(tab.posted.at(-1)).toEqual({
			type: "result",
			result: sampleAnalysis,
		});
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
		expect(keepAlive).toHaveBeenCalledTimes(4);
	});

	test("keepAlive stops when the tab disconnects; its failure is ignored", async () => {
		vi.useFakeTimers();
		const { listener, keepAlive } = setup((signal) => endless(signal));
		keepAlive.mockRejectedValue(new Error("indisponible"));
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 2);
		expect(keepAlive).toHaveBeenCalledTimes(2);
		expect(tab.port.disconnect).not.toHaveBeenCalled();
		tab.close();
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
		expect(keepAlive).toHaveBeenCalledTimes(2);
	});

	test("disconnect during ensureKnown → no toScanIn log, no scanStream", async () => {
		const { listener, debug, scanStream } = setup();
		let known!: () => void;
		vi.mocked(debug.ensureKnown).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				known = resolve;
			}),
		);
		const tab = fakePort();
		listener(tab.port);
		tab.send(scanRequest());
		await vi.waitFor(() => expect(debug.ensureKnown).toHaveBeenCalled());
		tab.close();
		known();
		await new Promise((r) => setTimeout(r, 0));
		expect(scanStream).not.toHaveBeenCalled();
		expect(debug.group).not.toHaveBeenCalled();
		expect(tab.posted).toEqual([]);
	});
});
