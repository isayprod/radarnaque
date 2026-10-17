import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { facebookAdapter } from "../lib/adapters/facebook";
import { twhAdapter } from "../lib/adapters/twh";
import type { CardRef } from "../lib/adapters/types";
import type { AiClient } from "../lib/content/ai-client";
import { defaultFetchPage, scanCard } from "../lib/content/card-scan";
import { evaluate } from "../lib/rules/score";
import { loadFixture, sampleAnalysis } from "./helpers";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXED_HTML = readFileSync(
	resolve(FIXTURES, "twh/listing-fixed.html"),
	"utf8",
);
const FIXED_URL =
	"https://www.2ememain.be/v/telephonie/apple-iphone/m1000000001-iphone-14-pro-128gb";
const TWH_SEARCH = new URL("https://www.2ememain.be/q/iphone/");
const FB_SEARCH = new URL("https://www.facebook.com/marketplace/brussels/");

let ai: AiClient & { scan: ReturnType<typeof vi.fn<AiClient["scan"]>> };
beforeEach(() => {
	ai = {
		access: vi.fn<AiClient["access"]>(),
		scan: vi.fn<AiClient["scan"]>(async () => ({
			ok: true,
			data: sampleAnalysis,
		})),
		openLogin: vi.fn<AiClient["openLogin"]>(),
	};
});

const twhCard = (url = FIXED_URL): CardRef => ({
	element: document.createElement("li"),
	externalId: "m1000000001",
	url,
});

function fbCard(id = "9000000000000001"): CardRef {
	const card = facebookAdapter
		.findCards(loadFixture("facebook/grid.html"), FB_SEARCH)
		.find((c) => c.externalId === id);
	if (!card) throw new Error(`no card ${id}`);
	return card;
}

describe("scanCard", () => {
	test("fiche récupérée et extraite : trigger card, partial false, signaux de la fiche", async () => {
		const fetchPage = vi.fn(async () => FIXED_HTML);
		const response = await scanCard(twhCard(), {
			pageUrl: TWH_SEARCH,
			adapter: twhAdapter,
			ai,
			fetchPage,
		});

		expect(response).toEqual({ ok: true, data: sampleAnalysis });
		expect(fetchPage).toHaveBeenCalledExactlyOnceWith(FIXED_URL);
		const expected = twhAdapter.extractListing(
			new DOMParser().parseFromString(FIXED_HTML, "text/html"),
			new URL(FIXED_URL),
		);
		if (!expected) throw new Error("fixture non extraite");
		const report = evaluate(expected.listing, {
			unknown: new Set(
				expected.missing.filter(
					(f): f is "description" | "images" =>
						f === "description" || f === "images",
				),
			),
		});
		expect(ai.scan).toHaveBeenCalledExactlyOnceWith({
			listing: expected.listing,
			signals: report.signals,
			rulesVersion: report.rulesVersion,
			scanKind: "text",
			trigger: "card",
			partial: false,
		});
	});

	test("Facebook, fiche illisible : repli sur la carte, partial true", async () => {
		const card = fbCard();
		const fetchPage = vi.fn(async () => "<html><body></body></html>");
		await scanCard(card, {
			pageUrl: FB_SEARCH,
			adapter: facebookAdapter,
			ai,
			fetchPage,
		});

		expect(fetchPage).toHaveBeenCalledExactlyOnceWith(card.url);
		const listing = facebookAdapter.listingFromCard?.(card.element, FB_SEARCH);
		if (!listing) throw new Error("listingFromCard a échoué");
		// Description et photos inconnues : leurs règles ne sont pas évaluées.
		const report = evaluate(listing, {
			unknown: new Set(["description", "images"]),
		});
		const request = ai.scan.mock.calls[0]?.[0];
		expect(request).toEqual({
			listing,
			signals: report.signals,
			rulesVersion: report.rulesVersion,
			scanKind: "text",
			trigger: "card",
			partial: true,
		});
		const ids = request?.signals.map((s) => s.id) ?? [];
		expect(ids).not.toContain("short_description");
		expect(ids).not.toContain("few_photos");
	});

	test("Facebook, fetchPage qui rejette : repli sur la carte", async () => {
		await scanCard(fbCard(), {
			pageUrl: FB_SEARCH,
			adapter: facebookAdapter,
			ai,
			fetchPage: vi.fn(async () => {
				throw new Error("HTTP 500");
			}),
		});
		expect(ai.scan.mock.calls[0]?.[0].partial).toBe(true);
	});

	test("carte d'une autre origine : invalid_listing, sans requête", async () => {
		const fetchPage = vi.fn(async () => FIXED_HTML);
		const response = await scanCard(
			twhCard(
				"https://www.2dehands.be/v/telephonie/apple-iphone/m1000000001-iphone-14-pro-128gb",
			),
			{ pageUrl: TWH_SEARCH, adapter: twhAdapter, ai, fetchPage },
		);
		expect(response).toEqual({ ok: false, error: { code: "invalid_listing" } });
		expect(fetchPage).not.toHaveBeenCalled();
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("URL de carte invalide : invalid_listing, sans requête", async () => {
		const fetchPage = vi.fn(async () => FIXED_HTML);
		const response = await scanCard(twhCard("pas une url"), {
			pageUrl: TWH_SEARCH,
			adapter: twhAdapter,
			ai,
			fetchPage,
		});
		expect(response).toEqual({ ok: false, error: { code: "invalid_listing" } });
		expect(fetchPage).not.toHaveBeenCalled();
	});

	test("fetchPage qui rejette, sans repli : invalid_listing", async () => {
		const response = await scanCard(twhCard(), {
			pageUrl: TWH_SEARCH,
			adapter: twhAdapter,
			ai,
			fetchPage: vi.fn(async () => {
				throw new Error("HTTP 404");
			}),
		});
		expect(response).toEqual({ ok: false, error: { code: "invalid_listing" } });
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("page lue mais sans fiche, sans repli : invalid_listing", async () => {
		const response = await scanCard(twhCard(), {
			pageUrl: TWH_SEARCH,
			adapter: twhAdapter,
			ai,
			fetchPage: vi.fn(async () => "<html><body></body></html>"),
		});
		expect(response).toEqual({ ok: false, error: { code: "invalid_listing" } });
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("repli impossible (carte sans titre) : invalid_listing", async () => {
		const card = fbCard();
		for (const span of card.element.querySelectorAll('span[dir="auto"]'))
			span.remove();
		const response = await scanCard(card, {
			pageUrl: FB_SEARCH,
			adapter: facebookAdapter,
			ai,
			fetchPage: vi.fn(async () => "<html><body></body></html>"),
		});
		expect(response).toEqual({ ok: false, error: { code: "invalid_listing" } });
		expect(ai.scan).not.toHaveBeenCalled();
	});
});

describe("defaultFetchPage", () => {
	test("fetch avec cookies et délai, rend le HTML", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () => new Response("<p>ok</p>", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(defaultFetchPage(FIXED_URL)).resolves.toBe("<p>ok</p>");
		const [input, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(input)).toBe(FIXED_URL);
		expect(init?.credentials).toBe("include");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	test("rejette si la réponse n'est pas ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("", { status: 404 })),
		);
		await expect(defaultFetchPage(FIXED_URL)).rejects.toThrow();
	});
});
