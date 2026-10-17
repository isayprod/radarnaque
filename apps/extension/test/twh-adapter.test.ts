import { describe, expect, test } from "vitest";
import { twhAdapter } from "../lib/adapters/twh";
import { parseAccountAge } from "../lib/listing/parse";
import { loadFixture } from "./helpers";

const FIXED_URL = new URL(
	"https://www.2ememain.be/v/telephonie/apple-iphone/m1000000001-iphone-14-pro-128gb",
);
const BIDDING_URL = new URL(
	"https://www.2ememain.be/v/vetements-femmes/chapeaux-casquettes/m1000000002-bonnet-laine-rose",
);

function fixed(): Document {
	return loadFixture("twh/listing-fixed.html");
}

function bidding(): Document {
	return loadFixture("twh/listing-bidding-skeleton.html");
}

function extract(doc: Document, url: URL) {
	const result = twhAdapter.extractListing(doc, url);
	if (!result) throw new Error("extractListing returned null");
	return result;
}

function configScript(doc: Document): HTMLScriptElement {
	const script = [...doc.querySelectorAll("script")].find((s) =>
		s.textContent?.startsWith("window.__CONFIG__ ="),
	);
	if (!script) throw new Error("no __CONFIG__ script");
	return script;
}

/** Modifie `window.__CONFIG__.listing` dans le texte du script de la fixture. */
function editListingConfig(
	doc: Document,
	edit: (listing: Record<string, unknown>) => void,
): void {
	const script = configScript(doc);
	const text = script.textContent ?? "";
	const config = JSON.parse(
		text.slice(text.indexOf("=") + 1, text.lastIndexOf(";")),
	);
	edit(config.listing);
	script.textContent = `window.__CONFIG__ = ${JSON.stringify(config)};`;
}

function setPriceInfo(doc: Document, priceType: string, priceCents: number) {
	editListingConfig(doc, (listing) => {
		listing.priceInfo = { priceType, priceCents };
	});
}

function verificationBody(doc: Document): Element {
	const item = [...doc.querySelectorAll("#vendeur li")].find((li) =>
		li.textContent?.startsWith("Vérification"),
	);
	const body = item?.lastElementChild?.lastElementChild;
	if (!body) throw new Error("no verification indicator");
	return body;
}

describe("twhAdapter.extractListing — listing-fixed", () => {
	test("reads the listing from __CONFIG__", () => {
		const { listing, missing } = extract(fixed(), FIXED_URL);
		expect(listing).toMatchObject({
			site: "2ememain.be",
			externalId: "m1000000001",
			url: FIXED_URL.href,
			title: "Iphone 14 PRO 128GB",
			price: { amountCents: 39900, currency: "EUR" },
			priceType: "fixed",
			category: "Téléphonie mobile | Apple iPhone",
			condition: "Comme neuf",
			postedAt: "2026-10-01T10:00:00Z",
			location: { city: "Namur", country: "BE" },
		});
		expect(missing).toEqual([]);
	});

	test("images: real count, absolute https URLs", () => {
		const { images } = extract(fixed(), FIXED_URL).listing;
		expect(images).toHaveLength(2);
		for (const src of images) {
			expect(src.startsWith("https://images.example/")).toBe(true);
			expect(src).not.toContain("#");
		}
	});

	test("seller fields", () => {
		const { seller } = extract(fixed(), FIXED_URL).listing;
		expect(seller).toEqual({
			id: "10000001",
			name: "TestVendeur",
			profileUrl: "https://www.2ememain.be/u/testvendeur/10000001/",
			accountAgeMonths: parseAccountAge("6 ans"),
			reviewCount: 21,
			rating: 4.5,
			otherListingsCount: 2,
			verified: true,
		});
	});

	test("account age comes from activeSinceDiff", () => {
		const doc = fixed();
		editListingConfig(doc, (listing) => {
			(listing.seller as Record<string, unknown>).activeSinceDiff = "2 mois";
		});
		expect(extract(doc, FIXED_URL).listing.seller.accountAgeMonths).toEqual({
			min: 2,
			max: 2,
		});
	});

	test("description comes from the DOM, line breaks kept", () => {
		const { description } = extract(fixed(), FIXED_URL).listing;
		expect(description).toBe("Très très bon état comme neuf\nAvec boîte");
	});

	test("missing description element → empty and reported", () => {
		const doc = fixed();
		doc.querySelector('[data-collapsable="description"]')?.remove();
		const { listing, missing } = extract(doc, FIXED_URL);
		expect(listing.description).toBe("");
		expect(missing).toContain("description");
	});

	test("missing gallery → no images and reported", () => {
		const doc = fixed();
		editListingConfig(doc, (listing) => {
			listing.gallery = {};
		});
		for (const s of doc.querySelectorAll('script[type="application/ld+json"]'))
			s.remove();
		const { listing, missing } = extract(doc, FIXED_URL);
		expect(listing.images).toEqual([]);
		expect(missing).toContain("images");
	});
});

describe("twhAdapter.extractListing — listing-bidding-skeleton", () => {
	test("bidding price, seller section skeleton without error", () => {
		const { listing, missing } = extract(bidding(), BIDDING_URL);
		expect(listing.externalId).toBe("m1000000002");
		expect(listing.priceType).toBe("bidding");
		expect(listing.price).toEqual({ amountCents: 6000, currency: "EUR" });
		expect(listing.images).toHaveLength(9);
		expect(listing.seller.verified).toBeUndefined();
		expect(listing.seller.otherListingsCount).toBeUndefined();
		expect(missing).toEqual(
			expect.arrayContaining(["seller.verified", "seller.otherListingsCount"]),
		);
	});

	test("reviews come from the sidebar summary, which is always rendered", () => {
		const { seller } = extract(bidding(), BIDDING_URL).listing;
		expect(seller.reviewCount).toBe(83);
		expect(seller.rating).toBe(4.9);
	});

	test("no review link → reviewCount and rating unknown, without error", () => {
		const doc = bidding();
		for (const a of doc.querySelectorAll(
			'a[href*="/experiences/user-reviews/"]',
		)) {
			a.parentElement?.remove();
		}
		const { listing, missing } = extract(doc, BIDDING_URL);
		expect(listing.seller.reviewCount).toBeUndefined();
		expect(listing.seller.rating).toBeUndefined();
		expect(missing).toEqual(
			expect.arrayContaining(["seller.reviewCount", "seller.rating"]),
		);
	});
});

describe("twhAdapter.extractListing — price types", () => {
	test("FREE → no price, free", () => {
		const doc = fixed();
		setPriceInfo(doc, "FREE", 0);
		const { listing } = extract(doc, FIXED_URL);
		expect(listing.price).toBeNull();
		expect(listing.priceType).toBe("free");
	});

	test.each(["FAST_BID", "FREE_BID", "MIN_BID"])(
		"%s with 0 cents → no price, bidding",
		(type) => {
			const doc = fixed();
			setPriceInfo(doc, type, 0);
			const { listing } = extract(doc, FIXED_URL);
			expect(listing.price).toBeNull();
			expect(listing.priceType).toBe("bidding");
		},
	);

	test.each(["NOTK", "SEE_DESCRIPTION", "EXCHANGE", "RESERVED", "WHATEVER"])(
		"%s → no price, unknown",
		(type) => {
			const doc = fixed();
			setPriceInfo(doc, type, 39900);
			const { listing } = extract(doc, FIXED_URL);
			expect(listing.price).toBeNull();
			expect(listing.priceType).toBe("unknown");
		},
	);
});

describe("twhAdapter.extractListing — seller verification", () => {
	test.each([
		"Rien n'a été vérifié concernant ce vendeur.",
		"Rien n’a été vérifié concernant ce vendeur.",
		"Er is niets van de verkoper gecontroleerd.",
	])("%s → verified false", (text) => {
		const doc = fixed();
		verificationBody(doc).textContent = text;
		expect(extract(doc, FIXED_URL).listing.seller.verified).toBe(false);
	});
});

describe("twhAdapter.extractListing — privacy and stale data", () => {
	test("visitor data from __ENV_CONFIG__ never leaks", () => {
		const doc = fixed();
		const script = doc.createElement("script");
		script.textContent =
			'window.__ENV_CONFIG__ = {"userDetails":{"location":{"city":"Visiteurville","postcode":"9999"}}};';
		doc.body.prepend(script);
		const json = JSON.stringify(extract(doc, FIXED_URL));
		expect(json).not.toContain("Visiteurville");
		expect(json).not.toContain("9999");
	});

	test("stale __CONFIG__ (other id) → JSON-LD and DOM fallback", () => {
		const doc = fixed();
		const h1 = doc.querySelector("#seller-sidebar-root header h1");
		const priceDiv = h1?.nextElementSibling;
		if (!h1 || !priceDiv) throw new Error("fixture header changed");
		h1.textContent = "Nouvelle annonce";
		priceDiv.textContent = "€ 12,50";
		const url = new URL(
			"https://www.2ememain.be/v/telephonie/apple-iphone/m1000000099-nouvelle-annonce",
		);
		const { listing, missing } = extract(doc, url);
		expect(listing.externalId).toBe("m1000000099");
		expect(listing.title).toBe("Nouvelle annonce");
		expect(listing.price).toEqual({ amountCents: 1250, currency: "EUR" });
		expect(listing.priceType).toBe("fixed");
		expect(listing.location).toEqual({});
		expect(listing.seller.name).toBeUndefined();
		expect(missing).toContain("images");
	});

	test("no __CONFIG__ → JSON-LD Product fallback", () => {
		const doc = fixed();
		configScript(doc).remove();
		const { listing } = extract(doc, FIXED_URL);
		expect(listing.title).toBe("Iphone 14 PRO 128GB");
		expect(listing.price).toEqual({ amountCents: 39900, currency: "EUR" });
		expect(listing.images).toEqual([
			"https://images.example/twh/1$_86",
			"https://images.example/twh/2$_86",
		]);
	});

	test("no title anywhere → null", () => {
		const doc = fixed();
		configScript(doc).remove();
		for (const s of doc.querySelectorAll('script[type="application/ld+json"]'))
			s.remove();
		for (const h1 of doc.querySelectorAll("h1")) h1.remove();
		expect(twhAdapter.extractListing(doc, FIXED_URL)).toBeNull();
	});

	test("not a listing page → null", () => {
		const url = new URL("https://www.2ememain.be/l/telephonie/");
		expect(twhAdapter.extractListing(fixed(), url)).toBeNull();
	});
});

describe("twhAdapter — site, page type, anchor", () => {
	test("siteOf", () => {
		expect(
			twhAdapter.siteOf(new URL("https://www.2dehands.be/v/x/y/m1-z")),
		).toBe("2dehands.be");
		expect(twhAdapter.siteOf(FIXED_URL)).toBe("2ememain.be");
	});

	test("2dehands listing → site 2dehands.be", () => {
		const url = new URL(
			"https://www.2dehands.be/v/telefonie/apple-iphone/m1000000001-iphone-14-pro-128-gb",
		);
		expect(extract(fixed(), url).listing.site).toBe("2dehands.be");
	});

	test("pageType", () => {
		const empty = new DOMParser().parseFromString("", "text/html");
		expect(twhAdapter.pageType(FIXED_URL, fixed())).toBe("listing");
		expect(
			twhAdapter.pageType(
				new URL("https://www.2ememain.be/l/telephonie/"),
				empty,
			),
		).toBe("other");
		expect(twhAdapter.pageType(FIXED_URL, empty)).toBe("other");
		expect(
			twhAdapter.pageType(
				new URL("https://www.2ememain.be/V/X/Y/M1000000001-Z"),
				fixed(),
			),
		).toBe("listing");
	});

	test("listingRoot is the body on a listing page", () => {
		const doc = fixed();
		expect(twhAdapter.listingRoot(doc, FIXED_URL)).toBe(doc.body);
		const other = new URL("https://www.2ememain.be/l/telephonie/");
		expect(twhAdapter.listingRoot(doc, other)).toBeNull();
	});

	test("badgeAnchor is the sidebar h1, else the first h1", () => {
		const doc = fixed();
		const anchor = twhAdapter.badgeAnchor(doc.body);
		expect(anchor).toBe(doc.querySelector("#seller-sidebar-root header h1"));
		expect(anchor?.textContent).toBe("Iphone 14 PRO 128GB");

		const other = new DOMParser().parseFromString(
			"<main><h1>Un</h1><h1>Deux</h1></main>",
			"text/html",
		);
		expect(twhAdapter.badgeAnchor(other.body)?.textContent).toBe("Un");
	});
});
