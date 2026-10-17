import { describe, expect, test, vi } from "vitest";
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

function decoyReviews(doc: Document, sellerId: string, count: number) {
	const div = doc.createElement("div");
	div.innerHTML = `<span>1.2 · </span><a href="https://www.2ememain.be/experiences/user-reviews/${sellerId}/"><span> ${count} avis</span></a>`;
	return div;
}

describe("twhAdapter.extractListing — seller reviews scope", () => {
	test("a visitor 'my reviews' link in the page header is ignored", () => {
		const doc = fixed();
		const header = doc.createElement("header");
		header.append(decoyReviews(doc, "99999999", 7));
		doc.body.prepend(header);
		const { seller } = extract(doc, FIXED_URL).listing;
		expect(seller.reviewCount).toBe(21);
		expect(seller.rating).toBe(4.5);
	});

	test("a review link of another user inside the sidebar is ignored", () => {
		const doc = fixed();
		doc
			.querySelector("#seller-sidebar-root")
			?.prepend(decoyReviews(doc, "100000011", 7));
		const { seller } = extract(doc, FIXED_URL).listing;
		expect(seller.reviewCount).toBe(21);
		expect(seller.rating).toBe(4.5);
	});
});

describe("twhAdapter.extractListing — images authority", () => {
	test("valid __CONFIG__ with an empty gallery → zero photos, known", () => {
		const doc = fixed();
		editListingConfig(doc, (listing) => {
			listing.gallery = { imageUrls: [] };
		});
		const { listing, missing } = extract(doc, FIXED_URL);
		expect(listing.images).toEqual([]);
		expect(missing).not.toContain("images");
	});
});

describe("twhAdapter.extractListing — verification wording", () => {
	test.each([
		["Le vendeur a été vérifié sur le numéro de téléphone.", true],
		["De verkoper is gecontroleerd op telefoonnummer.", true],
		["De verkoper is geverifieerd.", true],
		["Vendeur non vérifié.", false],
		["Le numéro n'a pas été vérifié.", false],
		["Telefoonnummer niet gecontroleerd.", false],
		["Geen gegevens gecontroleerd.", false],
		["Profil vérifié bientôt", undefined],
	])("%s → %s", (text, expected) => {
		const doc = fixed();
		verificationBody(doc).textContent = text;
		expect(extract(doc, FIXED_URL).listing.seller.verified).toBe(expected);
	});
});

describe("twhAdapter.extractListing — JSON-LD fallback", () => {
	test("Product without sku is ignored when __CONFIG__ is absent", () => {
		const doc = fixed();
		configScript(doc).remove();
		const ld = [
			...doc.querySelectorAll('script[type="application/ld+json"]'),
		].find((s) => s.textContent?.includes('"Product"'));
		if (!ld) throw new Error("no Product JSON-LD");
		const product = JSON.parse(ld.textContent ?? "");
		delete product.sku;
		ld.textContent = JSON.stringify(product);
		const { listing, missing } = extract(doc, FIXED_URL);
		expect(listing.images).toEqual([]);
		expect(missing).toContain("images");
	});

	test("fallback title prefers the h1 over JSON-LD", () => {
		const doc = fixed();
		configScript(doc).remove();
		const h1 = doc.querySelector("#seller-sidebar-root header h1");
		if (!h1) throw new Error("no h1");
		h1.textContent = "Titre du DOM";
		expect(extract(doc, FIXED_URL).listing.title).toBe("Titre du DOM");
	});
});

describe("twhAdapter.extractListing — other listings count", () => {
	test("seller-written card titles are not counted", () => {
		const doc = fixed();
		const root = doc.querySelector("#seller-other-items-root");
		if (!root) throw new Error("no other items root");
		const card = doc.createElement("a");
		card.innerHTML = "<p>Lot de 30 annonces de magazines</p>";
		root.append(card);
		expect(extract(doc, FIXED_URL).listing.seller.otherListingsCount).toBe(2);

		for (const span of root.querySelectorAll("span")) span.remove();
		expect(
			extract(doc, FIXED_URL).listing.seller.otherListingsCount,
		).toBeUndefined();
	});
});

describe("twhAdapter.extractListing — seller profile URL", () => {
	test.each([
		"javascript:alert(1)",
		"https://evil.example/u/x/1/",
		"//evil.example/u/",
	])("%s is rejected", (value) => {
		const doc = fixed();
		editListingConfig(doc, (listing) => {
			(listing.seller as Record<string, unknown>).sellerProfileUrl = value;
		});
		const { listing, missing } = extract(doc, FIXED_URL);
		expect(listing.seller.profileUrl).toBeUndefined();
		expect(missing).toContain("seller.profileUrl");
	});
});

describe("twhAdapter.extractListing — robustness and NL", () => {
	test("malformed __CONFIG__ → DOM fallback without throwing", () => {
		const doc = fixed();
		configScript(doc).textContent = "window.__CONFIG__ = { not json };";
		const { listing } = extract(doc, FIXED_URL);
		expect(listing.title).toBe("Iphone 14 PRO 128GB");
		expect(listing.price).toEqual({ amountCents: 39900, currency: "EUR" });
		expect(listing.location).toEqual({});
	});

	test("__CONFIG__ without trailing ; is still read", () => {
		const doc = fixed();
		const script = configScript(doc);
		script.textContent = (script.textContent ?? "").replace(/;\s*$/, "");
		const { listing } = extract(doc, FIXED_URL);
		expect(listing.location).toEqual({ city: "Namur", country: "BE" });
		expect(listing.seller.name).toBe("TestVendeur");
	});

	test("NL labels on 2dehands.be", () => {
		const doc = fixed();
		const label = [...doc.querySelectorAll("div")].find(
			(d) => d.textContent === "État",
		);
		if (!label) throw new Error("no condition label");
		label.textContent = "Conditie";
		const link = doc.querySelector(
			'#seller-sidebar-root a[href*="/experiences/user-reviews/"]',
		);
		if (!link?.previousElementSibling) throw new Error("no review link");
		link.textContent = " 21 reviews";
		link.previousElementSibling.textContent = "4,9 · ";
		const count = doc.querySelector("#seller-other-items-root span");
		if (!count) throw new Error("no other items count");
		count.textContent = "2 advertenties";
		const url = new URL(
			"https://www.2dehands.be/v/telefonie/apple-iphone/m1000000001-iphone-14-pro-128-gb",
		);
		const { listing } = extract(doc, url);
		expect(listing.site).toBe("2dehands.be");
		expect(listing.condition).toBe("Comme neuf");
		expect(listing.seller).toMatchObject({
			reviewCount: 21,
			rating: 4.9,
			otherListingsCount: 2,
			profileUrl: "https://www.2dehands.be/u/testvendeur/10000001/",
		});
	});
});

const SEARCH_URL = new URL("https://www.2ememain.be/q/iphone/");
const SEARCH_IDS = [
	"m1000000101",
	"m1000000102",
	"m1000000103",
	"m1000000104",
	"m1000000105",
	"m1000000106",
];

function search(): Document {
	return loadFixture("twh/search.html");
}

/** Cartes de la fixture, en échouant si la page n'en donne aucune. */
function searchCards(doc: Document, url = SEARCH_URL) {
	const cards = twhAdapter.findCards(doc, url);
	if (!cards.length) throw new Error("findCards returned no card");
	return cards;
}

describe("twhAdapter — page de résultats", () => {
	test("pageType vaut search sur /q/ et /l/ avec des cartes", () => {
		const doc = search();
		expect(twhAdapter.pageType(SEARCH_URL, doc)).toBe("search");
		expect(
			twhAdapter.pageType(
				new URL(
					"https://www.2ememain.be/l/telecoms/telephonie-mobile-apple-iphone/q/iphone/",
				),
				doc,
			),
		).toBe("search");
		expect(
			twhAdapter.pageType(new URL("https://www.2dehands.be/q/iphone/"), doc),
		).toBe("search");
	});

	test("coût par passage : pageType s'arrête à la première carte", () => {
		const doc = search();
		const closest = vi.spyOn(Element.prototype, "closest");
		const cardLookups = () =>
			closest.mock.calls.filter(([sel]) => sel === 'li, [role="listitem"]')
				.length;
		twhAdapter.findCards(doc, SEARCH_URL);
		const full = cardLookups();
		closest.mockClear();
		expect(twhAdapter.pageType(SEARCH_URL, doc)).toBe("search");
		expect(full).toBe(6);
		expect(cardLookups()).toBe(1);
	});

	test("pageType vaut other hors /l/ et /q/, ou sans carte", () => {
		const empty = new DOMParser().parseFromString("", "text/html");
		expect(
			twhAdapter.pageType(new URL("https://www.2ememain.be/"), search()),
		).toBe("other");
		expect(twhAdapter.pageType(SEARCH_URL, empty)).toBe("other");
		expect(twhAdapter.pageType(SEARCH_URL, fixed())).toBe("other");
		expect(twhAdapter.pageType(FIXED_URL, search())).toBe("other");
		expect(twhAdapter.pageType(FIXED_URL, fixed())).toBe("listing");
	});

	test("findCards rend les cartes hors annonces professionnelles (`a…`), dans l'ordre, sans suivi", () => {
		const doc = search();
		const cards = searchCards(doc);
		expect(cards.map((c) => c.externalId)).toEqual(SEARCH_IDS);
		for (const card of cards) {
			expect(card.element.tagName).toBe("LI");
			expect(card.url).toMatch(
				new RegExp(
					`^https://www\\.2ememain\\.be/v/telecoms/telephonie-mobile-apple-iphone/${card.externalId}-[a-z0-9-]+$`,
				),
			);
		}
		expect(cards[1]?.url).toBe(
			"https://www.2ememain.be/v/telecoms/telephonie-mobile-apple-iphone/m1000000102-iphone-14-pro",
		);
		// Une carte par élément de liste, malgré les trois variantes de mise en page.
		expect(new Set(cards.map((c) => c.element)).size).toBe(cards.length);
	});

	test("l'annonce professionnelle (`a…`), dont la fiche n'est pas encore prise en charge, et la carte sans lien sont ignorées", () => {
		const doc = search();
		const items = [...doc.querySelectorAll("ul > li")];
		const cards = searchCards(doc);
		expect(items).toHaveLength(9);
		expect(doc.querySelector('a[href*="/a1000000201-"]')).not.toBeNull();
		expect(cards.map((c) => c.element)).not.toContain(items[0]);
		expect(cards.map((c) => c.element)).not.toContain(items[2]);
		expect(cards[0]?.element).toBe(items[3]);
	});

	test("sur 2dehands, l'URL des cartes suit l'hôte de la page", () => {
		const url = new URL("https://www.2dehands.be/q/iphone/");
		const cards = searchCards(search(), url);
		expect(cards.map((c) => c.externalId)).toEqual(SEARCH_IDS);
		for (const card of cards) {
			expect(card.url.startsWith("https://www.2dehands.be/v/")).toBe(true);
		}
	});

	test("findCards rend [] hors page de résultats ou hors site", () => {
		const doc = search();
		expect(twhAdapter.findCards(doc, FIXED_URL)).toEqual([]);
		expect(
			twhAdapter.findCards(doc, new URL("https://www.2ememain.be/")),
		).toEqual([]);
		expect(
			twhAdapter.findCards(doc, new URL("https://www.example.com/q/iphone/")),
		).toEqual([]);
	});

	test("findCards sous une seule carte (ajout du défilement infini)", () => {
		const doc = search();
		const item = doc.querySelectorAll("ul > li")[4];
		if (!item) throw new Error("no list item");
		const cards = twhAdapter.findCards(item, SEARCH_URL);
		expect(cards.map((c) => c.externalId)).toEqual(["m1000000102"]);
		expect(cards[0]?.element).toBe(item);
	});

	test("un lien hors site ou sans id m<chiffres> n'est pas une carte", () => {
		const doc = search();
		const list = doc.querySelector("ul");
		for (const href of [
			"https://ads.example/v/telecoms/x/m1234567890-pub",
			"/v/telecoms/x/a1234567890-pub",
			"/v/telecoms/m1234567890-court",
		]) {
			const li = doc.createElement("li");
			const a = doc.createElement("a");
			a.setAttribute("href", href);
			a.textContent = "Pub";
			li.append(a);
			list?.prepend(li);
		}
		expect(searchCards(doc).map((c) => c.externalId)).toEqual(SEARCH_IDS);
	});
});

describe("twhAdapter.cardAnchor", () => {
	test("le titre de la carte, jamais null", () => {
		const doc = search();
		for (const card of searchCards(doc)) {
			const anchor = twhAdapter.cardAnchor(card.element);
			expect(anchor).not.toBeNull();
			const title = card.element.querySelector("img")?.getAttribute("alt");
			expect(anchor?.textContent).toBe(title);
			expect(anchor?.querySelector("img")).toBeNull();
			expect(card.element.contains(anchor)).toBe(true);
		}
		const first = searchCards(doc)[0];
		if (!first) throw new Error("no card");
		expect(twhAdapter.cardAnchor(first.element)?.textContent).toBe(
			"Apple iPhone 15 - 256 Go - Noir - Excellent état",
		);
	});

	test("le titre de la variante affichée", () => {
		const doc = search();
		const card = searchCards(doc)[0];
		if (!card) throw new Error("no card");
		const [desktop, tablet] = card.element.querySelectorAll('a[href*="/v/"]');
		if (!desktop || !tablet) throw new Error("no layout variants");
		desktop.checkVisibility = () => false;
		const anchor = twhAdapter.cardAnchor(card.element);
		expect(tablet.contains(anchor)).toBe(true);
		expect(anchor?.textContent).toBe(
			"Apple iPhone 15 - 256 Go - Noir - Excellent état",
		);
	});

	test("repli sur la carte quand elle n'a pas de titre", () => {
		const doc = search();
		const items = doc.querySelectorAll("ul > li");
		const banner = items[1];
		const noHref = items[2];
		if (!banner || !noHref) throw new Error("no list items");
		expect(twhAdapter.cardAnchor(banner)).toBe(banner);
		// Carte sans lien de fiche : son titre reste lisible.
		expect(twhAdapter.cardAnchor(noHref)?.textContent).toBe("iPhone SE 2020");
		const bare = doc.createElement("li");
		expect(twhAdapter.cardAnchor(bare)).toBe(bare);
	});
});
