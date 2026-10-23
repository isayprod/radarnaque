import { describe, expect, test } from "vitest";
import {
	isAnalysisResult,
	parseStreamMessage,
	toIdentificationResult,
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

	test("parses identification events", () => {
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
	});

	test("bounds the strings and arrays of an identification", () => {
		const [object] = sampleIdentification.objects;
		const page = { url: "https://a.be/x", title: "T", domain: "a.be" };
		const check = {
			observation: "seen_match",
			photo: 1,
			text: { fr: "x".repeat(1_000_000), nl: "y" },
			sources: Array(8).fill(page),
		};
		const big = {
			...sampleIdentification,
			objects: [
				{
					...object,
					label: "L".repeat(1_000_000),
					reference: "R".repeat(500),
					remaining: ["a", "b", "c", "d", "e"],
					checks: Array(12).fill(check),
					pages: Array(6).fill({
						url: `https://a.be/${"u".repeat(1_000)}`,
						title: "t".repeat(500),
						domain: "d".repeat(500),
					}),
				},
			],
			photoObservations: Array(9).fill({
				photo: null,
				kind: "watermark",
				note: "n".repeat(1_000),
			}),
			searches: Array(15).fill({
				kind: "price",
				query: "q".repeat(500),
				pagesRead: ["p".repeat(500)],
			}),
			titleMismatch: "m".repeat(1_000),
		};
		const out = parseStreamMessage(msg("identification", big));
		if (out?.type !== "identification") throw new Error("not parsed");
		const [o] = out.objects;
		expect(o?.label).toHaveLength(120);
		expect(o?.reference).toHaveLength(120);
		expect(o?.remaining).toEqual(["a", "b", "c"]);
		expect(o?.checks).toHaveLength(8);
		expect(o?.checks[0]?.text.fr).toHaveLength(300);
		expect(o?.checks[0]?.sources).toHaveLength(5);
		expect(o?.pages).toHaveLength(3);
		expect(o?.pages[0]?.url).toHaveLength(300);
		expect(o?.pages[0]?.title).toHaveLength(200);
		expect(o?.pages[0]?.domain).toHaveLength(100);
		expect(out.photoObservations).toHaveLength(6);
		expect(out.photoObservations[0]?.note).toHaveLength(300);
		expect(out.searches).toHaveLength(10);
		expect(out.searches[0]?.query).toHaveLength(200);
		expect(out.searches[0]?.pagesRead[0]).toHaveLength(100);
		expect(out.titleMismatch).toHaveLength(200);
	});

	test("drops a page or source link that is not https", () => {
		const [object] = sampleIdentification.objects;
		const ok = { url: "https://a.be/x", title: "A", domain: "a.be" };
		const bad = { url: "javascript:alert(1)", title: "B", domain: "b" };
		const http = { url: "http://c.be", title: "C", domain: "c.be" };
		const withLinks = {
			...sampleIdentification,
			objects: [
				{
					...object,
					pages: [bad, ok, http],
					checks: [
						{
							observation: "not_visible",
							photo: null,
							text: { fr: "a", nl: "b" },
							sources: [http, ok],
						},
					],
				},
			],
		};
		const out = parseStreamMessage(msg("result", withLinks), "identify");
		if (out?.type !== "result" || !("objects" in out.result)) {
			throw new Error("not parsed");
		}
		expect(out.result.objects[0]?.pages).toEqual([ok]);
		expect(out.result.objects[0]?.checks[0]?.sources).toEqual([ok]);
	});

	test("does not copy an unknown field", () => {
		const [object] = sampleIdentification.objects;
		const extra = {
			...sampleIdentification,
			evil: "x",
			objects: [{ ...object, evil: "y" }],
		};
		const out = parseStreamMessage(msg("result", extra), "identify");
		expect(out).toEqual({ type: "result", result: sampleIdentification });
		const event = parseStreamMessage(msg("identification", extra));
		expect(event).not.toHaveProperty("evil");
		expect(event).toEqual({ ...sampleIdentification, type: "identification" });
	});

	test("rejects an identification with an unknown level or more than 4 objects", () => {
		const [object] = sampleIdentification.objects;
		for (const bad of [
			{ ...sampleIdentification, level: "certain" },
			{ ...sampleIdentification, objects: [{ ...object, level: "certain" }] },
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

describe("parseStreamMessage : identification d'une analyse", () => {
	test("passes the identification embedded in an analysis result through toIdentificationResult", () => {
		expect(
			parseStreamMessage(
				msg("result", {
					...sampleAnalysis,
					identification: { ...sampleIdentification, extra: "<b>x</b>" },
				}),
			),
		).toEqual({
			type: "result",
			result: { ...sampleAnalysis, identification: sampleIdentification },
		});
		// Identification invalide : champ à null, l'analyse est gardée.
		expect(
			parseStreamMessage(
				msg("result", {
					...sampleAnalysis,
					identification: { ...sampleIdentification, level: "certain" },
				}),
			),
		).toEqual({
			type: "result",
			result: { ...sampleAnalysis, identification: null },
		});
		expect(
			parseStreamMessage(
				msg("result", { ...sampleAnalysis, identification: null }),
			),
		).toEqual({
			type: "result",
			result: { ...sampleAnalysis, identification: null },
		});
	});
});

describe("toIdentificationResult", () => {
	test("copies the API shape, refuses a wrong one", () => {
		expect(toIdentificationResult(sampleIdentification)).toEqual(
			sampleIdentification,
		);
		const withDebug = { ...sampleIdentification, debug: { steps: [] } };
		expect(toIdentificationResult(withDebug)).toEqual(withDebug);
		for (const value of [
			null,
			[],
			{ ...sampleIdentification, status: "maybe" },
			{ ...sampleIdentification, confidence: 101 },
			{ ...sampleIdentification, confidence: 1.5 },
			{ ...sampleIdentification, identificationId: "7" },
			{ ...sampleIdentification, objects: [{ role: "main" }] },
			{ ...sampleIdentification, sellerQuestion: { fr: "x" } },
			{
				...sampleIdentification,
				photoObservations: [{ photo: 1, kind: "other", note: "x" }],
			},
		]) {
			expect(toIdentificationResult(value)).toBeNull();
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
