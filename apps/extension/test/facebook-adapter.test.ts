import { describe, expect, test } from "vitest";
import {
	createFacebookAdapter,
	facebookAdapter,
} from "../lib/adapters/facebook";
import { loadFixture } from "./helpers";

const ITEM_URL = new URL(
	"https://www.facebook.com/marketplace/item/1234567890/",
);
const GRID_URL = new URL("https://www.facebook.com/marketplace/");
const NOW = new Date("2026-10-17T12:00:00Z");

const adapter = createFacebookAdapter(() => NOW);

function modal(): Document {
	return loadFixture("facebook/item-modal.html");
}

function page(): Document {
	return loadFixture("facebook/item-page.html");
}

function extract(doc: Document, url: URL = ITEM_URL) {
	const result = adapter.extractListing(doc, url);
	if (!result) throw new Error("extractListing returned null");
	return result;
}

function rootOf(doc: Document): Element {
	const root = adapter.listingRoot(doc, ITEM_URL);
	if (!root) throw new Error("no listing root");
	return root;
}

function priceSpan(doc: Document): Element {
	const span = rootOf(doc)
		.querySelector("h1")
		?.nextElementSibling?.querySelector('span[dir="auto"]');
	if (!span) throw new Error("no price span");
	return span;
}

function spanWithText(root: Element, text: string): Element {
	const span = [...root.querySelectorAll('span[dir="auto"]')].find(
		(s) => s.textContent?.trim() === text,
	);
	if (!span) throw new Error(`no span ${text}`);
	return span;
}

describe("facebookAdapter : fiche en modale", () => {
	test("extrait le Listing de la fiche", () => {
		const { listing } = extract(modal());
		expect(listing).toMatchObject({
			site: "facebook.com",
			externalId: "1234567890",
			url: "https://www.facebook.com/marketplace/item/1234567890/",
			title: "Appareil photo canon EOS 3000 avec objectif",
			price: { amountCents: 5000, currency: "EUR" },
			priceType: "fixed",
			condition: "D’occasion - comme neuf",
			description:
				"Le flash fonctionne parfaitement. Objectif est très bon état. Compartiment piles nickel.",
			location: { city: "Namur", region: "WAL", country: "BE" },
			seller: {
				id: "10000001",
				name: "Vendeur Test",
				profileUrl: "https://www.facebook.com/marketplace/profile/10000001/",
			},
		});
	});

	test("5 photos distinctes, dans l'ordre", () => {
		expect(extract(modal()).listing.images).toEqual([
			"https://images.example/fb/1.jpg",
			"https://images.example/fb/2.jpg",
			"https://images.example/fb/3.jpg",
			"https://images.example/fb/4.jpg",
			"https://images.example/fb/5.jpg",
		]);
	});

	test("ancienneté depuis « A rejoint Facebook en 2007 », avec l'horloge injectée", () => {
		const age = extract(modal()).listing.seller.accountAgeMonths;
		// Du 31/12/2007 au 17/10/2026 : 225 mois complets ; du 01/01/2007 : 237.
		expect(age).toEqual({ min: 225, max: 237 });
		expect(age?.max).toBeGreaterThan(200);
	});

	test("l'adaptateur par défaut calcule aussi une ancienneté", () => {
		const result = facebookAdapter.extractListing(modal(), ITEM_URL);
		expect(result?.listing.seller.accountAgeMonths?.max).toBeGreaterThan(200);
	});

	test("les cartes de la grille sous la modale ne contaminent rien", () => {
		const doc = modal();
		const root = rootOf(doc);
		expect(root.getAttribute("role")).toBe("dialog");
		const { listing } = extract(doc);
		expect(listing.title).toBe("Appareil photo canon EOS 3000 avec objectif");
		for (const src of listing.images) expect(src).not.toMatch(/\/1\d\.jpg$/);
		// Même si la grille porte des photos au libellé de fiche.
		const card = doc.querySelector('[role="main"] img');
		card?.setAttribute("alt", "Photo de produit de Garmin");
		expect(extract(doc).listing.images).toHaveLength(5);
	});

	test("missing liste les champs que Facebook n'affiche pas", () => {
		const { missing } = extract(modal());
		expect(missing).toEqual(
			expect.arrayContaining([
				"category",
				"postedAt",
				"seller.reviewCount",
				"seller.rating",
				"seller.otherListingsCount",
				"seller.verified",
			]),
		);
		for (const key of [
			"price",
			"description",
			"images",
			"condition",
			"location.city",
			"location.country",
			"seller.id",
			"seller.name",
			"seller.accountAgeMonths",
		]) {
			expect(missing).not.toContain(key);
		}
	});

	test("l'ancre est le h1 de la fiche", () => {
		const doc = modal();
		const root = rootOf(doc);
		expect(adapter.badgeAnchor(root)?.textContent).toBe(
			"Appareil photo canon EOS 3000 avec objectif",
		);
	});
});

describe("facebookAdapter : fiche en page", () => {
	test("produit le même Listing que la modale, à l'URL près", () => {
		const other = new URL(
			"https://www.facebook.com/marketplace/item/9000000000000007/?ref=search",
		);
		const fromPage = extract(page(), other);
		const fromModal = extract(modal());
		expect(rootOf(page()).getAttribute("role")).toBe("main");
		expect(fromPage.listing.url).toBe(
			"https://www.facebook.com/marketplace/item/9000000000000007/",
		);
		expect(fromPage.listing.externalId).toBe("9000000000000007");
		expect({ ...fromPage.listing, url: "", externalId: "" }).toEqual({
			...fromModal.listing,
			url: "",
			externalId: "",
		});
		expect(fromPage.missing).toEqual(fromModal.missing);
	});
});

describe("facebookAdapter : grille et pages hors fiche", () => {
	test("grid : search, pas de fiche", () => {
		const doc = loadFixture("facebook/grid.html");
		expect(adapter.pageType(GRID_URL, doc)).toBe("search");
		expect(adapter.listingRoot(doc, GRID_URL)).toBeNull();
		expect(adapter.extractListing(doc, GRID_URL)).toBeNull();
	});

	test.each([
		["https://www.facebook.com/marketplace/item/1234567890/", "listing"],
		["https://www.facebook.com/marketplace/namur/", "search"],
		["https://www.facebook.com/marketplace/namur/search/?query=velo", "search"],
		["https://www.facebook.com/marketplace/category/vehicles", "search"],
		["https://www.facebook.com/marketplace/profile/10000001/", "other"],
		["https://www.facebook.com/marketplace/inbox/", "other"],
		["https://www.facebook.com/marketplace/you/selling", "other"],
		["https://www.facebook.com/marketplace/create/item", "other"],
		["https://www.facebook.com/", "other"],
		["https://www.facebook.com/marketplacefoo/", "other"],
	])("pageType(%s) = %s", (url, type) => {
		expect(adapter.pageType(new URL(url), modal())).toBe(type);
	});

	test("une fiche hors URL d'annonce donne null", () => {
		expect(adapter.listingRoot(modal(), GRID_URL)).toBeNull();
		expect(adapter.extractListing(modal(), GRID_URL)).toBeNull();
	});

	test("un autre site donne null", () => {
		const url = new URL("https://m.facebook.com/marketplace/item/1234567890/");
		expect(adapter.extractListing(modal(), url)).toBeNull();
	});
});

describe("facebookAdapter : racine", () => {
	test("sans lien vers le profil du vendeur : null", () => {
		const doc = modal();
		for (const a of doc.querySelectorAll('a[href*="/marketplace/profile/"]'))
			a.remove();
		expect(adapter.listingRoot(doc, ITEM_URL)).toBeNull();
		expect(adapter.extractListing(doc, ITEM_URL)).toBeNull();
	});

	test("sans h1 dans la racine : null", () => {
		const doc = page();
		rootOf(doc).querySelector("h1")?.remove();
		expect(adapter.listingRoot(doc, ITEM_URL)).toBeNull();
	});

	test("un dialogue incomplet est ignoré au profit d'un autre qui contient la fiche", () => {
		const doc = modal();
		const empty = doc.createElement("div");
		empty.setAttribute("role", "dialog");
		empty.innerHTML = "<h1>Notifications</h1>";
		doc.body.prepend(empty);
		expect(rootOf(doc).getAttribute("aria-label")).toBe(
			"Visionneuse de petites annonces Marketplace",
		);
	});

	test("titre vide : null", () => {
		const doc = modal();
		const h1 = rootOf(doc).querySelector("h1");
		if (h1) h1.innerHTML = '<span dir="auto">  </span>';
		expect(adapter.extractListing(doc, ITEM_URL)).toBeNull();
	});
});

describe("facebookAdapter : prix", () => {
	test.each([
		["GRATUIT", "free"],
		["Gratis", "free"],
		["Free", "free"],
	])("%s : free, sans montant", (text, type) => {
		const doc = modal();
		priceSpan(doc).textContent = text;
		const { listing } = extract(doc);
		expect(listing.priceType).toBe(type);
		expect(listing.price).toBeNull();
	});

	test("€ 0 reste un prix fixe à 0", () => {
		const doc = modal();
		priceSpan(doc).textContent = "€ 0";
		expect(extract(doc).listing).toMatchObject({
			price: { amountCents: 0, currency: "EUR" },
			priceType: "fixed",
		});
	});

	test("texte illisible : prix inconnu, signalé dans missing", () => {
		const doc = modal();
		priceSpan(doc).textContent = "Prix sur demande";
		const { listing, missing } = extract(doc);
		expect(listing.price).toBeNull();
		expect(listing.priceType).toBe("unknown");
		expect(missing).toContain("price");
	});
});

describe("facebookAdapter : champs absents", () => {
	test("région hors Belgique : pas de pays", () => {
		const doc = modal();
		const link = rootOf(doc).querySelector(
			'a[href="https://www.facebook.com/marketplace/100000000000001/"]',
		);
		if (link) link.textContent = "Lille, FR";
		const { listing, missing } = extract(doc);
		expect(listing.location).toEqual({ city: "Lille", region: "FR" });
		expect(missing).toContain("location.country");
	});

	test("sans lieu : location vide et signalée", () => {
		const doc = modal();
		rootOf(doc)
			.querySelector(
				'a[href="https://www.facebook.com/marketplace/100000000000001/"]',
			)
			?.remove();
		const { listing, missing } = extract(doc);
		expect(listing.location).toEqual({});
		expect(missing).toEqual(
			expect.arrayContaining(["location.city", "location.country"]),
		);
	});

	test("sans photos : images vide et signalée", () => {
		const doc = modal();
		for (const img of rootOf(doc).querySelectorAll("img")) img.remove();
		const { listing, missing } = extract(doc);
		expect(listing.images).toEqual([]);
		expect(missing).toContain("images");
	});

	test("photos non http(s) ignorées, libellés EN et NL acceptés", () => {
		const doc = modal();
		const imgs = [
			...rootOf(doc).querySelectorAll("img[alt^='Photo de produit de ']"),
		];
		imgs[1]?.setAttribute("src", "data:image/png;base64,AAAA");
		imgs[2]?.setAttribute("alt", "Product photo of X");
		imgs[3]?.setAttribute("alt", "Productfoto van X");
		imgs[3]?.setAttribute("src", "http://images.example/fb/3.jpg?x=1");
		expect(extract(doc).listing.images).toEqual([
			"https://images.example/fb/1.jpg",
			"https://images.example/fb/2.jpg",
			"http://images.example/fb/3.jpg?x=1",
			"https://images.example/fb/4.jpg",
			"https://images.example/fb/5.jpg",
		]);
	});

	test.each(["Détails", "Details", "Beschrijving"])(
		"sans ligne État : description lue après le titre « %s »",
		(title) => {
			const doc = modal();
			const root = rootOf(doc);
			const label = spanWithText(root, "État");
			label.closest('[aria-hidden="false"]')?.remove();
			const heading = [...root.querySelectorAll("h2 div")].find(
				(d) => d.textContent === "Détails",
			);
			if (!heading) throw new Error("no Détails heading");
			heading.textContent = title;
			const { listing, missing } = extract(doc);
			expect(listing.condition).toBeUndefined();
			expect(missing).toContain("condition");
			expect(listing.description).toBe(
				"Le flash fonctionne parfaitement. Objectif est très bon état. Compartiment piles nickel.",
			);
		},
	);

	test.each(["Condition", "Staat"])("libellé %s de l'état", (label) => {
		const doc = modal();
		spanWithText(rootOf(doc), "État").textContent = label;
		const { listing } = extract(doc);
		expect(listing.condition).toBe("D’occasion - comme neuf");
		expect(listing.description).toMatch(/^Le flash/);
	});

	test("sans description : vide et signalée, sans lire la ligne du lieu", () => {
		const doc = modal();
		const root = rootOf(doc);
		spanWithText(
			root,
			"Le flash fonctionne parfaitement.  Objectif est très bon état.  Compartiment piles nickel.",
		)
			.closest('[aria-hidden="false"]')
			?.remove();
		const { listing, missing } = extract(doc);
		expect(listing.description).toBe("");
		expect(missing).toContain("description");
	});

	test("description sur plusieurs lignes : sauts de ligne gardés", () => {
		const doc = modal();
		const root = rootOf(doc);
		const span = spanWithText(
			root,
			"Le flash fonctionne parfaitement.  Objectif est très bon état.  Compartiment piles nickel.",
		);
		span.textContent = "Ligne 1  \n\n\n  Ligne 2";
		expect(extract(doc).listing.description).toBe("Ligne 1\n\nLigne 2");
	});

	test("sans ligne « A rejoint Facebook » : ancienneté inconnue", () => {
		const doc = modal();
		rootOf(doc).querySelector('[role="listitem"]')?.remove();
		const { listing, missing } = extract(doc);
		expect(listing.seller.accountAgeMonths).toBeUndefined();
		expect(missing).toContain("seller.accountAgeMonths");
	});

	test("lien vendeur sans aria-label : nom inconnu, id gardé", () => {
		const doc = modal();
		for (const a of rootOf(doc).querySelectorAll("a[aria-label]"))
			a.removeAttribute("aria-label");
		const { listing, missing } = extract(doc);
		expect(listing.seller.id).toBe("10000001");
		expect(listing.seller.name).toBeUndefined();
		expect(missing).toContain("seller.name");
	});
});
