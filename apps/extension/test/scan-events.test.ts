import { describe, expect, test } from "vitest";
import {
	isAnalysisResult,
	isIdentificationResult,
	parseStreamMessage,
} from "../lib/scan-events";
import { debugAnalysis, sampleAnalysis, sampleIdentification } from "./helpers";

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

	test("accepts the identification stages", () => {
		for (const stage of [
			"reading_photos",
			"criteria",
			"identifying",
			"retrying",
		]) {
			expect(parseStreamMessage(msg("stage", { stage }))).toEqual({
				type: "stage",
				stage,
			});
		}
	});

	test("parses identification events and bounds their strings", () => {
		expect(
			parseStreamMessage(
				msg("page_read", { domain: "d".repeat(150), ok: false }),
			),
		).toEqual({ type: "page_read", domain: "d".repeat(100), ok: false });
		expect(parseStreamMessage(msg("page_read", { domain: "a.be" }))).toBeNull();
		expect(parseStreamMessage(msg("criteria_cached", { count: 3 }))).toEqual({
			type: "criteria_cached",
			count: 3,
		});
		expect(
			parseStreamMessage(msg("criteria_cached", { count: -1 })),
		).toBeNull();
		expect(
			parseStreamMessage(msg("identification", sampleIdentification)),
		).toEqual({ ...sampleIdentification, type: "identification" });
		expect(
			parseStreamMessage(
				msg("identification_error", { code: "identify_resolve" }),
			),
		).toEqual({ type: "identification_error", code: "identify_resolve" });
		expect(
			parseStreamMessage(msg("identification_error", { code: "<script>" })),
		).toBeNull();
		expect(
			parseStreamMessage(
				msg("search", { id: 1, query: "q".repeat(300), aspect: "model" }),
			),
		).toMatchObject({ query: "q".repeat(200) });
	});

	test("rejects an identification with an unknown level or more than 4 objects", () => {
		const [object] = sampleIdentification.objects;
		for (const bad of [
			{ ...sampleIdentification, level: "certain" },
			{ ...sampleIdentification, objects: Array(5).fill(object) },
		]) {
			expect(parseStreamMessage(msg("identification", bad))).toBeNull();
			expect(parseStreamMessage(msg("result", bad), "identify")).toEqual({
				type: "error",
				code: "invalid_response",
			});
		}
	});

	test("an identify stream result must be an IdentificationOut", () => {
		expect(
			parseStreamMessage(msg("result", sampleIdentification), "identify"),
		).toEqual({ type: "result", result: sampleIdentification });
		expect(
			parseStreamMessage(msg("result", sampleAnalysis), "identify"),
		).toEqual({ type: "error", code: "invalid_response" });
		expect(parseStreamMessage(msg("result", sampleIdentification))).toEqual({
			type: "error",
			code: "invalid_response",
		});
		expect(
			parseStreamMessage(
				msg("result", {
					...sampleAnalysis,
					identification: sampleIdentification,
				}),
			),
		).toMatchObject({ type: "result" });
	});
});

describe("isIdentificationResult", () => {
	test("accepts the API shape, refuses a wrong one", () => {
		expect(isIdentificationResult(sampleIdentification)).toBe(true);
		for (const value of [
			null,
			[],
			{ ...sampleIdentification, status: "maybe" },
			{ ...sampleIdentification, confidence: 101 },
			{ ...sampleIdentification, confidence: 1.5 },
			{ ...sampleIdentification, identificationId: "7" },
			{ ...sampleIdentification, objects: [{ role: "main" }] },
		]) {
			expect(isIdentificationResult(value)).toBe(false);
		}
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
