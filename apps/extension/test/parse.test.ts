import { describe, expect, test } from "vitest";
import {
	normalizeText,
	parseAccountAge,
	parseFacebookJoinYear,
	parsePriceText,
} from "../lib/listing/parse";

describe("parsePriceText", () => {
	test.each([
		[
			"€ 60,00",
			{ price: { amountCents: 6000, currency: "EUR" }, priceType: "fixed" },
		],
		[
			"8\u00a0500 €",
			{ price: { amountCents: 850000, currency: "EUR" }, priceType: "fixed" },
		],
		[
			"€ 23\u202f500",
			{ price: { amountCents: 2350000, currency: "EUR" }, priceType: "fixed" },
		],
		[
			"50 €",
			{ price: { amountCents: 5000, currency: "EUR" }, priceType: "fixed" },
		],
		[
			"€ 1 234",
			{ price: { amountCents: 123400, currency: "EUR" }, priceType: "fixed" },
		],
		["GRATUIT", { price: null, priceType: "free" }],
		["Gratis", { price: null, priceType: "free" }],
		["€ 0", { price: { amountCents: 0, currency: "EUR" }, priceType: "fixed" }],
		[
			"8 500 €",
			{ price: { amountCents: 850000, currency: "EUR" }, priceType: "fixed" },
		],
		[
			"€ 1.234,50",
			{ price: { amountCents: 123450, currency: "EUR" }, priceType: "fixed" },
		],
		[
			"€ 12,5",
			{ price: { amountCents: 1250, currency: "EUR" }, priceType: "fixed" },
		],
		["Free", { price: null, priceType: "free" }],
	])("parsePriceText(%j)", (input, expected) => {
		expect(parsePriceText(input)).toEqual(expected);
	});

	test("returns null for non-price text", () => {
		expect(parsePriceText("Mons, WAL")).toBeNull();
		expect(parsePriceText("")).toBeNull();
	});

	test("never misreads ambiguous text as a price", () => {
		expect(parsePriceText("2 photos")).toBeNull();
		expect(parsePriceText("€ 60.00")).toBeNull();
		expect(parsePriceText("€ abc")).toBeNull();
	});
});

describe("parseAccountAge", () => {
	test.each([
		["10 ans", { min: 120, max: 131 }],
		["1 an", { min: 12, max: 23 }],
		["6 mois", { min: 6, max: 6 }],
		["3 semaines", { min: 0, max: 0 }],
		["10 jaar", { min: 120, max: 131 }],
		["6 maanden", { min: 6, max: 6 }],
		["3 weken", { min: 0, max: 0 }],
		["12 semaines", { min: 2, max: 2 }],
		["16 semaines", { min: 3, max: 3 }],
		["45 jours", { min: 1, max: 1 }],
		["14 dagen", { min: 0, max: 0 }],
	])("parseAccountAge(%j)", (input, expected) => {
		expect(parseAccountAge(input)).toEqual(expected);
	});

	test("returns null for unrecognised text", () => {
		expect(parseAccountAge("")).toBeNull();
		expect(parseAccountAge("Membre depuis peu")).toBeNull();
	});
});

describe("parseFacebookJoinYear", () => {
	test("computes the month range from the join year", () => {
		const now = new Date("2026-10-17T00:00:00Z");
		expect(parseFacebookJoinYear("A rejoint Facebook en 2007", now)).toEqual({
			min: 225,
			max: 237,
		});
		expect(parseFacebookJoinYear("Joined Facebook in 2026", now)).toEqual({
			min: 0,
			max: 9,
		});
		expect(parseFacebookJoinYear("Lid van Facebook sinds 2026", now)).toEqual({
			min: 0,
			max: 9,
		});
		expect(parseFacebookJoinYear("Membre depuis peu", now)).toBeNull();
	});
});

describe("normalizeText", () => {
	test("collapses whitespace and maps special spaces", () => {
		expect(normalizeText("  8\u00a0500\u202f€ \u2009 net \n ")).toBe(
			"8 500 € net",
		);
	});
});
