import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisResult, Me, ScanIn } from "@radarnaque/shared";
import { vi } from "vitest";

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
	features: ["card_icons", "image_scan"],
	unlimited: false,
	periodStart: null,
	quotas: [
		{ scanKind: "text", limit: 3, used: 0, remaining: 3 },
		{ scanKind: "image", limit: 3, used: 0, remaining: 3 },
	],
	totalCap: { scanKind: null, limit: 3, used: 0, remaining: 3 },
};

export const sampleAnalysis: AnalysisResult = {
	analysisId: 42,
	analyzedAt: "2026-10-18T10:00:00Z",
	fromCache: false,
	level: "medium",
	partial: false,
	score: 55,
	summary: { fr: "Prudence.", nl: "Voorzichtig." },
	advice: { fr: "Payez à la remise.", nl: "Betaal bij overhandiging." },
	reasons: [],
	remaining: { text: 2, image: 3, total: 2 },
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
	scanKind: "text",
	trigger: "button",
	partial: false,
};
