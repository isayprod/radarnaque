import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AnalysisResult,
	IdentificationResult,
	Me,
	ScanIn,
} from "@radarnaque/shared";
import { expect, vi } from "vitest";
import type { InternalSender } from "../lib/background-handlers";
import { type PortLike, type PortMessage, SCAN_PORT } from "../lib/scan-port";
import type { SseMessage } from "../lib/sse";

const FIXTURES_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);

/** Charge `test/fixtures/<relPath>` et l'analyse comme une page HTML. */
export function loadFixture(relPath: string): Document {
	const html = readFileSync(resolve(FIXTURES_DIR, relPath), "utf8");
	return new DOMParser().parseFromString(html, "text/html");
}

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
	features: ["card_icons"],
	unlimited: false,
	maxImages: 4,
	periodStart: null,
	quotas: [{ scanKind: "full", limit: 3, used: 0, remaining: 3 }],
	totalCap: { scanKind: null, limit: 3, used: 0, remaining: 3 },
};

/**
 * Forme renvoyée par `/api/me` pour le superuser de développement (hors production) :
 * vu en Premium (plan, fonctionnalités et photos), illimité, sans quota affiché.
 */
export const superuserMe: Me = {
	userId: "user-su",
	email: "superuser@radarnaque.test",
	role: "superuser",
	plan: "premium",
	features: ["card_icons"],
	unlimited: true,
	maxImages: 4,
	periodStart: null,
	quotas: [],
	totalCap: null,
};

export const sampleAnalysis: AnalysisResult = {
	analysisId: 42,
	analyzedAt: "2026-10-18T10:00:00Z",
	fromCache: false,
	level: "medium",
	partial: false,
	professional: false,
	score: 55,
	summary: { fr: "Prudence.", nl: "Voorzichtig." },
	advice: { fr: "Payez à la remise.", nl: "Betaal bij overhandiging." },
	reasons: [],
	remaining: { scans: 2 },
	imagesAnalyzed: 0,
	webSearches: [],
};

/** `IdentificationOut` minimal : un objet identifié. */
export const sampleIdentification: IdentificationResult = {
	identificationId: 7,
	status: "identified",
	confidence: 95,
	level: "sure",
	objects: [
		{
			role: "main",
			label: "Console",
			reference: "Steam Deck OLED",
			confidence: 95,
			level: "sure",
			remaining: ["Steam Deck OLED"],
			checks: [],
			pages: [
				{
					url: "https://www.steamdeck.com/fr/tech",
					title: "Tech specs",
					domain: "www.steamdeck.com",
				},
			],
		},
	],
	sellerQuestion: null,
	titleMismatch: null,
	photoObservations: [
		{ photo: 1, kind: "catalog", note: "photo du fabricant" },
	],
	searches: [
		{ query: "Steam Deck OLED prix occasion", kind: "price", pagesRead: [] },
	],
	verifiedCriteria: false,
	unsourced: false,
	imagesAnalyzed: 2,
	fromCache: false,
	identifiedAt: "2026-10-23T10:00:00Z",
	remaining: null,
};

/** Bloc `debug` d'un superuser (hors production), avec des empreintes longues. */
export const sampleDebug: NonNullable<AnalysisResult["debug"]> = {
	analysisId: 42,
	contentHash:
		"c0ffee0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	costUsdMicros: 1234,
	fromCache: false,
	inputHash: "feedface0123456789abcdef0123456789abcdef0123456789abcdef01234567",
	llmCalled: true,
	messages: [
		{ role: "user", content: "Annonce : Vélo <b>gras</b>" },
		{ role: "user", content: "[image 1 : 2048 octets]" },
	],
	model: "modele-test",
	promptVersion: { scanKind: "full", version: 1 },
	provider: "fournisseur-test",
	rawResponse: '{"score": 55}',
	reasoning: "",
	rounds: 1,
	searches: [],
	snapshotId: 7,
	systemPrompt: "Tu analyses une annonce.",
	timingsMs: { images: null, llm: 900, search: null, total: 950 },
	tokensIn: 100,
	tokensOut: 20,
};

/** Résultat d'un superuser : l'analyse type et son bloc `debug`. */
export const debugAnalysis: AnalysisResult = {
	...sampleAnalysis,
	debug: sampleDebug,
};

/** Corps de scan minimal, déjà nettoyé (sortie de `toScanIn`). */
export const sampleScanIn: ScanIn = {
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
		seller: { reviewCount: 4 },
	},
	rules: { version: 2, signals: [] },
	trigger: "button",
	partial: false,
};

/** Événement SSE tel que l'API l'écrit : `event:` puis `data:` en JSON sur une ligne. */
export function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Corps en flux qui livre chaque morceau (texte ou octets) séparément, puis se ferme. */
export function sseBody(
	...chunks: Array<string | Uint8Array>
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(
					typeof chunk === "string" ? encoder.encode(chunk) : chunk,
				);
			}
			controller.close();
		},
	});
}

/** Réponse `200 text/event-stream` de `POST /api/scans/stream`. */
export function sseResponse(...chunks: string[]): Response {
	return new Response(sseBody(...chunks), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Messages SSE déjà lus, comme les rend `scanStream`. */
export async function* sseMessages(
	...messages: SseMessage[]
): AsyncIterable<SseMessage> {
	yield* messages;
}

/** Message SSE `event` dont les données sont `data` en JSON. */
export const sse = (event: string, data: unknown): SseMessage => ({
	event,
	data: JSON.stringify(data),
});

/**
 * Faux `runtime.Port` vu du service worker. `send` simule un message de l'onglet,
 * `close` sa fermeture du port ; `posted` reçoit ce que le service worker poste.
 */
export function fakePort(name: string = SCAN_PORT, sender?: InternalSender) {
	const messageListeners: Array<(message: unknown) => void> = [];
	const disconnectListeners: Array<() => void> = [];
	const posted: PortMessage[] = [];
	const port = {
		name,
		sender,
		postMessage: vi.fn((message: PortMessage) => {
			posted.push(message);
		}),
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
	} satisfies PortLike;
	return {
		port,
		posted,
		send(message: unknown) {
			for (const fn of messageListeners) fn(message);
		},
		close() {
			for (const fn of disconnectListeners) fn();
		},
		/** Attend que le service worker ferme le port, puis rend son dernier message. */
		async closed(): Promise<PortMessage | undefined> {
			await vi.waitFor(() => expect(port.disconnect).toHaveBeenCalled());
			return posted.at(-1);
		},
	};
}
