import { describe, expect, test } from "vitest";
import { isAnalysisResult, parseStreamMessage } from "../lib/scan-events";
import { debugAnalysis, sampleAnalysis } from "./helpers";

const msg = (event: string, data: unknown) => ({
	event,
	data: typeof data === "string" ? data : JSON.stringify(data),
});

describe("parseStreamMessage", () => {
	test("stage, avec ou sans nombre de photos", () => {
		expect(parseStreamMessage(msg("stage", { stage: "cache" }))).toEqual({
			type: "stage",
			stage: "cache",
		});
		expect(
			parseStreamMessage(msg("stage", { stage: "photos", count: 3 })),
		).toEqual({ type: "stage", stage: "photos", count: 3 });
		expect(parseStreamMessage(msg("stage", { stage: "boot" }))).toBeNull();
		expect(
			parseStreamMessage(msg("stage", { stage: "photos", count: -1 })),
		).toBeNull();
	});

	test("un texte de 700 caractères est coupé à 600", () => {
		const event = parseStreamMessage(
			msg("thinking", { part: 2, text: "é".repeat(700) }),
		);
		expect(event).toEqual({ type: "thinking", part: 2, text: "é".repeat(600) });
	});

	test("une requête est coupée à 200", () => {
		expect(
			parseStreamMessage(
				msg("search", { id: 1, query: "q".repeat(250), aspect: "price" }),
			),
		).toEqual({
			type: "search",
			id: 1,
			query: "q".repeat(200),
			aspect: "price",
		});
	});

	test("domains est limité à 3 éléments de 100 caractères", () => {
		const long = `${"a".repeat(120)}.be`;
		expect(
			parseStreamMessage(
				msg("search_done", {
					id: 1,
					ok: true,
					count: 5,
					domains: [long, "b.be", "c.be", "d.be"],
				}),
			),
		).toEqual({
			type: "search_done",
			id: 1,
			ok: true,
			count: 5,
			domains: ["a".repeat(100), "b.be", "c.be"],
		});
		expect(
			parseStreamMessage(
				msg("search_done", { id: 1, ok: true, count: 5, domains: [3] }),
			),
		).toBeNull();
	});

	test("un type inconnu donne null", () => {
		expect(parseStreamMessage(msg("message", { stage: "cache" }))).toBeNull();
		expect(parseStreamMessage(msg("debug", { text: "x" }))).toBeNull();
	});

	test("un aspect inconnu donne null", () => {
		expect(
			parseStreamMessage(
				msg("search", { id: 1, query: "iphone", aspect: "seller" }),
			),
		).toBeNull();
	});

	test("données illisibles ou de mauvaise forme : null", () => {
		expect(parseStreamMessage(msg("thinking", "{pas du json"))).toBeNull();
		expect(parseStreamMessage(msg("thinking", "null"))).toBeNull();
		expect(
			parseStreamMessage(msg("thinking", { part: "2", text: "x" })),
		).toBeNull();
		expect(
			parseStreamMessage(
				msg("search", { id: 1.5, query: "x", aspect: "model" }),
			),
		).toBeNull();
	});

	test("seuls les champs connus sont gardés", () => {
		expect(
			parseStreamMessage(
				msg("thinking", { part: 1, text: "ok", html: "<b>x</b>" }),
			),
		).toEqual({ type: "thinking", part: 1, text: "ok" });
	});

	test("result valide : le résultat, debug compris", () => {
		expect(parseStreamMessage(msg("result", sampleAnalysis))).toEqual({
			type: "result",
			result: sampleAnalysis,
		});
		expect(parseStreamMessage(msg("result", debugAnalysis))).toEqual({
			type: "result",
			result: debugAnalysis,
		});
	});

	test("result sans score donne invalid_response", () => {
		const { score: _, ...withoutScore } = sampleAnalysis;
		expect(parseStreamMessage(msg("result", withoutScore))).toEqual({
			type: "error",
			code: "invalid_response",
		});
		expect(parseStreamMessage(msg("result", "{pas du json"))).toEqual({
			type: "error",
			code: "invalid_response",
		});
	});

	test("error : le code du flux, analysis_failed compris", () => {
		expect(
			parseStreamMessage(
				msg("error", {
					code: "analysis_failed",
					message: "L'analyse a échoué.",
					details: { reason: "timeout" },
				}),
			),
		).toEqual({ type: "error", code: "analysis_failed" });
		expect(parseStreamMessage(msg("error", { message: "x" }))).toBeNull();
		expect(parseStreamMessage(msg("error", { code: "<script>" }))).toBeNull();
	});

	test("ignores identification events and keeps parsing the result", () => {
		const identification = {
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
				{
					query: "Steam Deck OLED prix occasion",
					kind: "price",
					pagesRead: [],
				},
			],
			verifiedCriteria: false,
			unsourced: false,
			imagesAnalyzed: 2,
			fromCache: false,
			identifiedAt: "2026-10-23T10:00:00Z",
			remaining: null,
		};
		const stream = [
			msg("stage", { stage: "photos", count: 2 }),
			msg("stage", { stage: "reading_photos" }),
			msg("search", { id: 1, query: "steam deck", aspect: "model" }),
			msg("page_read", { domain: "versus.example", ok: true }),
			msg("criteria_cached", { count: 3 }),
			msg("identification", identification),
			msg("identification_error", { code: "identify_resolve" }),
			msg("stage", { stage: "analyzing", count: 0 }),
			msg("result", { ...sampleAnalysis, identification }),
		];
		const out = stream.map(parseStreamMessage).filter((e) => e !== null);
		expect(out).toEqual([
			{ type: "stage", stage: "photos", count: 2 },
			{ type: "search", id: 1, query: "steam deck", aspect: "model" },
			{ type: "stage", stage: "analyzing", count: 0 },
			{ type: "result", result: { ...sampleAnalysis, identification } },
		]);
		expect(isAnalysisResult({ ...sampleAnalysis, identification })).toBe(true);
	});
});

describe("isAnalysisResult", () => {
	test("accepte le résultat de l'API", () => {
		expect(isAnalysisResult(sampleAnalysis)).toBe(true);
		expect(
			isAnalysisResult({
				...sampleAnalysis,
				remaining: { scans: null },
				webSearches: [{ query: "prix iphone 15", aspect: "price" }],
			}),
		).toBe(true);
	});

	test("refuse une forme incomplète ou fausse", () => {
		for (const value of [
			null,
			"result",
			[],
			{ ...sampleAnalysis, score: "55" },
			{ ...sampleAnalysis, score: 101 },
			{ ...sampleAnalysis, level: "extreme" },
			{ ...sampleAnalysis, summary: { fr: "x" } },
			{ ...sampleAnalysis, reasons: [{ severity: "info" }] },
			{ ...sampleAnalysis, remaining: { text: 2, image: 3, total: 2 } },
			{ ...sampleAnalysis, imagesAnalyzed: undefined },
			{ ...sampleAnalysis, webSearches: [{ query: "x", aspect: "seller" }] },
			{ ...sampleAnalysis, debug: "secret" },
		]) {
			expect(isAnalysisResult(value)).toBe(false);
		}
	});
});
