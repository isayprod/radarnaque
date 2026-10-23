import type { ScanProgressEvent } from "@radarnaque/shared";
import { describe, expect, test, vi } from "vitest";
import { createAiClient } from "../lib/content/ai-client";
import type { ScanRequest } from "../lib/messages";
import { type PortLike, SCAN_PORT } from "../lib/scan-port";
import { sampleAnalysis, sampleIdentification } from "./helpers";

const request = { trigger: "button", partial: false } as ScanRequest;

/**
 * Faux `runtime.Port` vu de l'onglet. `receive` simule un message du service worker,
 * `drop` sa fermeture du port (service worker arrêté, ou fin postée puis fermeture).
 */
function contentPort() {
	const messageListeners: Array<(message: unknown) => void> = [];
	const disconnectListeners: Array<() => void> = [];
	const port = {
		name: SCAN_PORT,
		postMessage: vi.fn((_message: ScanRequest) => {}),
		disconnect: vi.fn(),
		onMessage: {
			addListener: (fn: (message: unknown) => void) => {
				messageListeners.push(fn);
			},
		},
		onDisconnect: {
			addListener: (fn: () => void) => {
				disconnectListeners.push(fn);
			},
		},
	} satisfies PortLike<ScanRequest>;
	return {
		port,
		connect: vi.fn((_name: string) => port),
		receive(message: unknown) {
			for (const fn of messageListeners) fn(message);
		},
		drop() {
			for (const fn of disconnectListeners) fn();
		},
	};
}

const neverSent = vi.fn(async () => {
	throw new Error("aucun message attendu");
});

describe("createAiClient : scan par le port scan/stream", () => {
	test("delivers events then result", async () => {
		const fake = contentPort();
		const client = createAiClient(fake.connect, neverSent);
		const events: ScanProgressEvent[] = [];
		const { done } = client.scan(request, (e) => events.push(e));

		expect(fake.connect).toHaveBeenCalledWith(SCAN_PORT);
		expect(fake.port.postMessage.mock.calls).toEqual([[request]]);
		const photos = { type: "stage", stage: "photos", count: 2 } as const;
		const search = {
			type: "search",
			id: 1,
			query: "vélo prix",
			aspect: "price",
		} as const;
		fake.receive({ type: "event", event: photos });
		fake.receive({ type: "event", event: search });
		fake.receive({ type: "result", result: sampleAnalysis });
		// La fermeture qui suit la fin ne change rien.
		fake.drop();

		await expect(done).resolves.toEqual({ ok: true, data: sampleAnalysis });
		expect(events).toEqual([photos, search]);
	});

	test("une erreur postée donne son code ; rien n'est relayé après la fin", async () => {
		const fake = contentPort();
		const onEvent = vi.fn();
		const { done } = createAiClient(fake.connect, neverSent).scan(
			request,
			onEvent,
		);
		fake.receive({ type: "error", code: "quota_exhausted" });
		fake.receive({ type: "event", event: { type: "stage", stage: "writing" } });
		fake.receive({ type: "result", result: sampleAnalysis });
		await expect(done).resolves.toEqual({
			ok: false,
			error: { code: "quota_exhausted" },
		});
		expect(onEvent).not.toHaveBeenCalled();
	});

	test("disconnect without outcome gives stream_interrupted", async () => {
		// Service worker MV3 arrêté en cours d'analyse : le port se ferme sans `result`.
		const fake = contentPort();
		const onEvent = vi.fn();
		const { done } = createAiClient(fake.connect, neverSent).scan(
			request,
			onEvent,
		);
		fake.receive({ type: "event", event: { type: "stage", stage: "writing" } });
		fake.drop();
		await expect(done).resolves.toEqual({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		expect(onEvent).toHaveBeenCalledTimes(1);
	});

	test("cancel disconnects port", async () => {
		const fake = contentPort();
		const onEvent = vi.fn();
		const scan = createAiClient(fake.connect, neverSent).scan(request, onEvent);
		scan.cancel();
		expect(fake.port.disconnect).toHaveBeenCalledTimes(1);
		// Un message déjà en route n'est plus relayé ; l'issue est `cancelled`.
		fake.receive({ type: "event", event: { type: "stage", stage: "writing" } });
		fake.receive({ type: "result", result: sampleAnalysis });
		await expect(scan.done).resolves.toEqual({
			ok: false,
			error: { code: "cancelled" },
		});
		expect(onEvent).not.toHaveBeenCalled();
		scan.cancel();
		expect(fake.port.disconnect).toHaveBeenCalledTimes(1);
	});

	test("cancel après la fin : le port n'est pas refermé", async () => {
		const fake = contentPort();
		const scan = createAiClient(fake.connect, neverSent).scan(request, vi.fn());
		fake.receive({ type: "result", result: sampleAnalysis });
		scan.cancel();
		await expect(scan.done).resolves.toEqual({
			ok: true,
			data: sampleAnalysis,
		});
		expect(fake.port.disconnect).not.toHaveBeenCalled();
	});

	test("connect qui lève : background_unavailable", async () => {
		const connect = vi.fn((_name: string): PortLike<ScanRequest> => {
			throw new Error("Extension context invalidated.");
		});
		const scan = createAiClient(connect, neverSent).scan(request, vi.fn());
		await expect(scan.done).resolves.toEqual({
			ok: false,
			error: { code: "background_unavailable" },
		});
		expect(() => scan.cancel()).not.toThrow();
	});

	test("postMessage qui lève : background_unavailable, port fermé", async () => {
		const fake = contentPort();
		fake.port.postMessage.mockImplementation(() => {
			throw new Error("Attempting to use a disconnected port object");
		});
		const scan = createAiClient(fake.connect, neverSent).scan(request, vi.fn());
		await expect(scan.done).resolves.toEqual({
			ok: false,
			error: { code: "background_unavailable" },
		});
		expect(fake.port.disconnect).toHaveBeenCalled();
	});

	test("message de forme inconnue : ignoré", async () => {
		const fake = contentPort();
		const onEvent = vi.fn();
		const { done } = createAiClient(fake.connect, neverSent).scan(
			request,
			onEvent,
		);
		for (const junk of [null, "texte", { type: "autre" }, { type: "event" }])
			fake.receive(junk);
		fake.receive({ type: "error", code: 42 });
		fake.receive({ type: "result" });
		fake.drop();
		await expect(done).resolves.toEqual({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		expect(onEvent).not.toHaveBeenCalled();
	});
});

describe("createAiClient : identification par le port scan/stream", () => {
	test("identify sends purpose identify on the scan port and resolves with the identification", async () => {
		const fake = contentPort();
		const client = createAiClient(fake.connect, neverSent);
		const events: ScanProgressEvent[] = [];
		const { done } = client.identify(request, (e) => events.push(e));

		expect(fake.connect).toHaveBeenCalledWith(SCAN_PORT);
		expect(fake.port.postMessage.mock.calls).toEqual([
			[{ ...request, purpose: "identify" }],
		]);
		const stage = { type: "stage", stage: "reading_photos" } as const;
		fake.receive({ type: "event", event: stage });
		fake.receive({ type: "result", result: sampleIdentification });
		fake.drop();

		await expect(done).resolves.toEqual({
			ok: true,
			data: sampleIdentification,
		});
		expect(events).toEqual([stage]);
	});

	test("une fin d'une autre forme que celle demandée donne invalid_response", async () => {
		const fake = contentPort();
		const client = createAiClient(fake.connect, neverSent);
		const identify = client.identify(request, vi.fn());
		fake.receive({ type: "result", result: sampleAnalysis });
		await expect(identify.done).resolves.toEqual({
			ok: false,
			error: { code: "invalid_response" },
		});

		const other = contentPort();
		const scan = createAiClient(other.connect, neverSent).scan(
			request,
			vi.fn(),
		);
		other.receive({ type: "result", result: sampleIdentification });
		await expect(scan.done).resolves.toEqual({
			ok: false,
			error: { code: "invalid_response" },
		});
	});
});

describe("createAiClient : messages", () => {
	test("access et openLogin envoient content/access et ui/open-popup", async () => {
		const send = vi.fn(async () => ({ ok: true as const, data: null }));
		const client = createAiClient(contentPort().connect, send as never);
		await client.access();
		await client.openLogin();
		expect(send.mock.calls).toEqual([
			[{ type: "content/access" }],
			[{ type: "ui/open-popup" }],
		]);
	});

	test("renvoie la réponse du service worker telle quelle", async () => {
		const response = { ok: false as const, error: { code: "unauthenticated" } };
		const client = createAiClient(
			contentPort().connect,
			(async () => response) as never,
		);
		await expect(client.access()).resolves.toBe(response);
	});
});
