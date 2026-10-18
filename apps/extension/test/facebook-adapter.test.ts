import { describe, expect, test } from "vitest";
import {
	createFacebookAdapter,
	facebookAdapter,
} from "../lib/adapters/facebook";
import { loadFixture } from "./helpers";

// Id porté par les `product_id` des liens vendeur des deux fixtures de fiche.
const ITEM_ID = "9000000000000007";
const ITEM_URL = new URL(
	`https://www.facebook.com/marketplace/item/${ITEM_ID}/`,
);
const OTHER_ITEM_URL = new URL(
	"https://www.facebook.com/marketplace/item/9000000000000008/",
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
			externalId: "9000000000000007",
			url: "https://www.facebook.com/marketplace/item/9000000000000007/",
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
				"seller.sellerKind",
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

	test("le type de vendeur n'est jamais renseigné", () => {
		const { listing } = extract(modal());
		expect(listing.seller).not.toHaveProperty("sellerKind");
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
	test("produit le même Listing que la modale (query de l'URL retirée)", () => {
		const withQuery = new URL(`${ITEM_URL.href}?ref=search`);
		const fromPage = extract(page(), withQuery);
		const fromModal = extract(modal());
		expect(rootOf(page()).getAttribute("role")).toBe("main");
		expect(fromPage.listing.url).toBe(ITEM_URL.href);
		expect(fromPage.listing).toEqual(fromModal.listing);
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

	test.each([
		["https://www.facebook.com/", "facebook.com"],
		["https://facebook.com/", "facebook.com"],
		["https://web.facebook.com/", "facebook.com"],
		["https://m.facebook.com/", null],
		["https://evil.web.facebook.com/", null],
	])("siteOf(%s) = %s", (url, site) => {
		expect(adapter.siteOf(new URL(url))).toBe(site);
	});

	test("web.facebook.com : la fiche est extraite", () => {
		const url = new URL(
			`https://web.facebook.com/marketplace/item/${ITEM_ID}/`,
		);
		const { listing } = extract(modal(), url);
		expect(listing.site).toBe("facebook.com");
		expect(listing.externalId).toBe(ITEM_ID);
		expect(listing.location).toEqual({
			city: "Namur",
			region: "WAL",
			country: "BE",
		});
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

	test("navigation A → B : la modale encore affichée décrit A, donc null", () => {
		const doc = modal();
		expect(adapter.listingRoot(doc, OTHER_ITEM_URL)).toBeNull();
		expect(adapter.extractListing(doc, OTHER_ITEM_URL)).toBeNull();
	});

	test("un dialogue d'une autre annonce cède la place à la page qui correspond", () => {
		const doc = page();
		const stale = doc.createElement("div");
		stale.setAttribute("role", "dialog");
		stale.innerHTML = rootOf(doc).innerHTML.replaceAll(
			`product_id=${ITEM_ID}`,
			"product_id=9000000000000008",
		);
		const title = stale.querySelector("h1 span");
		if (title) title.textContent = "Annonce précédente";
		doc.body.prepend(stale);
		expect(rootOf(doc).getAttribute("role")).toBe("main");
		expect(extract(doc).listing.title).toBe(
			"Appareil photo canon EOS 3000 avec objectif",
		);
	});

	test.each([
		[
			"un lien vendeur d'une autre annonce",
			'<h1>Annonce de chat</h1><a href="https://www.facebook.com/marketplace/profile/2/?product_id=555">x</a>',
		],
		[
			"un h1 « Notifications »",
			'<h1>Notifications</h1><a href="https://www.facebook.com/marketplace/profile/2/">x</a>',
		],
	])("un dialogue étranger avec %s ne masque pas la page", (_, html) => {
		const doc = page();
		const foreign = doc.createElement("div");
		foreign.setAttribute("role", "dialog");
		foreign.innerHTML = html;
		doc.body.prepend(foreign);
		expect(rootOf(doc).getAttribute("role")).toBe("main");
		expect(extract(doc).listing.seller.id).toBe("10000001");
	});

	test("liens vendeur sans product_id : la racine est acceptée", () => {
		const doc = modal();
		for (const a of rootOf(doc).querySelectorAll(
			'a[href*="/marketplace/profile/"]',
		))
			a.setAttribute(
				"href",
				"https://www.facebook.com/marketplace/profile/10000001/",
			);
		expect(extract(doc, OTHER_ITEM_URL).listing.externalId).toBe(
			"9000000000000008",
		);
	});

	test("dialogues imbriqués : le plus profond est choisi", () => {
		const doc = modal();
		const inner = rootOf(doc);
		const outer = doc.createElement("div");
		outer.setAttribute("role", "dialog");
		inner.replaceWith(outer);
		outer.append(inner);
		expect(adapter.listingRoot(doc, ITEM_URL)).toBe(inner);
	});

	test("le h1 « Marketplace » de la page est ignoré", () => {
		const doc = page();
		const nav = doc.createElement("div");
		nav.innerHTML = "<h1>Marketplace</h1>";
		rootOf(doc).prepend(nav);
		const { listing } = extract(doc);
		expect(listing.title).toBe("Appareil photo canon EOS 3000 avec objectif");
		expect(listing.price?.amountCents).toBe(5000);
		expect(adapter.badgeAnchor(rootOf(doc))?.textContent).toBe(listing.title);
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

	test.each([
		"/marketplace/100000000000001/",
		"https://web.facebook.com/marketplace/100000000000001/",
		"https://facebook.com/marketplace/100000000000001",
	])("lien de lieu %s : reconnu par son chemin", (href) => {
		const doc = modal();
		rootOf(doc)
			.querySelector(
				'a[href="https://www.facebook.com/marketplace/100000000000001/"]',
			)
			?.setAttribute("href", href);
		const { listing } = extract(doc);
		expect(listing.location).toEqual({
			city: "Namur",
			region: "WAL",
			country: "BE",
		});
	});

	test("lien de lieu vers un autre site : ignoré", () => {
		const doc = modal();
		rootOf(doc)
			.querySelector(
				'a[href="https://www.facebook.com/marketplace/100000000000001/"]',
			)
			?.setAttribute("href", "https://evil.com/marketplace/100000000000001/");
		const { listing } = extract(doc);
		expect(listing.location).toEqual({});
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

	test("libellé État sans valeur : état inconnu, description intacte", () => {
		const doc = modal();
		const value = spanWithText(rootOf(doc), "D’occasion - comme neuf");
		value.parentElement?.closest("span")?.remove();
		const { listing, missing } = extract(doc);
		expect(listing.condition).toBeUndefined();
		expect(missing).toContain("condition");
		expect(listing.description).toMatch(/^Le flash/);
	});

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

const SEARCH_URL = new URL("https://www.facebook.com/marketplace/brussels/");
const GRID_IDS = [1, 2, 3, 4, 5, 6].map((n) => `900000000000000${n}`);

function grid(): Document {
	return loadFixture("facebook/grid.html");
}

/** Carte de `doc` dont l'id est `id`, telle que la renvoie `findCards`. */
function cardOf(doc: Document, id: string, url: URL = SEARCH_URL): Element {
	const card = adapter.findCards(doc, url).find((c) => c.externalId === id);
	if (!card) throw new Error(`no card ${id}`);
	return card.element;
}

function cardListing(doc: Document, id: string) {
	const listing = adapter.listingFromCard?.(cardOf(doc, id), SEARCH_URL);
	if (!listing) throw new Error(`listingFromCard(${id}) returned null`);
	return listing;
}

function appendLink(parent: Element, href: string): HTMLAnchorElement {
	const a = parent.ownerDocument.createElement("a");
	a.setAttribute("href", href);
	a.textContent = "lien";
	parent.append(a);
	return a;
}

describe("facebookAdapter : cartes de la grille (findCards)", () => {
	test("les 6 cartes, dans l'ordre du document", () => {
		const cards = adapter.findCards(grid(), SEARCH_URL);
		expect(cards.map((c) => c.externalId)).toEqual(GRID_IDS);
		for (const card of cards) {
			expect(card.element.matches('a[href*="/marketplace/item/"]')).toBe(true);
		}
	});

	test("url absolue de la fiche, sans paramètres", () => {
		for (const card of adapter.findCards(grid(), SEARCH_URL)) {
			expect(new URL(card.url).href).toBe(card.url);
			expect(card.url.endsWith(`/marketplace/item/${card.externalId}/`)).toBe(
				true,
			);
			expect(card.url).toBe(
				`https://www.facebook.com/marketplace/item/${card.externalId}/`,
			);
		}
	});

	test("lien relatif avec paramètres de suivi : url nettoyée", () => {
		const doc = grid();
		cardOf(doc, GRID_IDS[0] as string).setAttribute(
			"href",
			"/marketplace/item/9000000000000001/?ref=search&referral_code=abc#x",
		);
		const card = adapter.findCards(doc, SEARCH_URL)[0];
		expect(card?.url).toBe(
			"https://www.facebook.com/marketplace/item/9000000000000001/",
		);
	});

	test("doublons dédupliqués par id, première occurrence gardée", () => {
		const doc = grid();
		const main = doc.querySelector('[role="main"]') as Element;
		const dup = appendLink(
			main,
			"https://www.facebook.com/marketplace/item/9000000000000002/?ref=x",
		);
		const cards = adapter.findCards(doc, SEARCH_URL);
		expect(cards.map((c) => c.externalId)).toEqual(GRID_IDS);
		expect(cards[1]?.element).not.toBe(dup);
	});

	test("liens hors Facebook ou hors chemin de fiche : ignorés", () => {
		const doc = grid();
		const main = doc.querySelector('[role="main"]') as Element;
		appendLink(main, "https://evil.com/marketplace/item/9000000000000099/");
		appendLink(
			main,
			"https://www.facebook.com/l.php?u=https://www.facebook.com/marketplace/item/9000000000000098/",
		);
		appendLink(
			main,
			"https://m.facebook.com/marketplace/item/9000000000000097/",
		);
		const ids = adapter.findCards(doc, SEARCH_URL).map((c) => c.externalId);
		expect(ids).toEqual(GRID_IDS);
	});

	test("item-modal, URL de la fiche : aucune carte sous le dialogue", () => {
		const cards = adapter.findCards(modal(), ITEM_URL);
		expect(cards.some((c) => c.element.closest('[role="dialog"]'))).toBe(false);
		// Une URL de fiche n'est pas une page de recherche.
		expect(cards).toEqual([]);
	});

	test("cartes sous un [role=dialog] ignorées, la grille derrière gardée", () => {
		const doc = modal();
		const dialog = doc.querySelector('[role="dialog"]') as Element;
		appendLink(
			dialog,
			"https://www.facebook.com/marketplace/item/9000000000000009/",
		);
		const cards = adapter.findCards(doc, SEARCH_URL);
		expect(cards.map((c) => c.externalId)).toEqual([
			"9000000000000002",
			"9000000000000004",
		]);
	});

	test("racine limitée : seules les cartes sous la racine", () => {
		const doc = grid();
		const first = doc.querySelector('[data-virtualized="false"]') as Element;
		const cards = adapter.findCards(first, SEARCH_URL);
		expect(cards.map((c) => c.externalId)).toEqual([GRID_IDS[0]]);
	});

	test.each([
		"https://www.facebook.com/marketplace/profile/10000001/",
		"https://www.facebook.com/marketplace/inbox/",
		"https://www.facebook.com/",
		"https://m.facebook.com/marketplace/brussels/",
	])("hors page de recherche (%s) : aucune carte", (url) => {
		expect(adapter.findCards(grid(), new URL(url))).toEqual([]);
	});

	test("web.facebook.com : l'url des cartes suit l'hôte de la page", () => {
		const url = new URL("https://web.facebook.com/marketplace/brussels/");
		const cards = adapter.findCards(grid(), url);
		expect(cards.map((c) => c.url)).toEqual(
			GRID_IDS.map((id) => `https://web.facebook.com/marketplace/item/${id}/`),
		);
	});
});

describe("facebookAdapter : fiche en modale sur la grille (isOverlayListing)", () => {
	test("item-modal, URL de la fiche : modale sur la grille", () => {
		expect(adapter.isOverlayListing?.(modal(), ITEM_URL)).toBe(true);
	});

	test("fiche en page directe : pas une modale", () => {
		expect(adapter.isOverlayListing?.(page(), ITEM_URL)).toBe(false);
	});

	test("URL de recherche : pas une fiche, donc pas une modale", () => {
		expect(adapter.isOverlayListing?.(modal(), GRID_URL)).toBe(false);
	});

	test("dialogue d'une autre annonce : pas la modale de cette fiche", () => {
		expect(adapter.isOverlayListing?.(modal(), OTHER_ITEM_URL)).toBe(false);
	});

	test("plus aucun lien de la grille hors du dialogue : pas une modale", () => {
		const doc = modal();
		for (const link of doc.querySelectorAll(
			'[role="main"] a[href*="/marketplace/item/"]',
		))
			link.remove();
		expect(adapter.isOverlayListing?.(doc, ITEM_URL)).toBe(false);
	});
});

describe("facebookAdapter : ancre des cartes (cardAnchor)", () => {
	test("jamais null pour les 6 cartes, dans la carte", () => {
		const doc = grid();
		for (const card of adapter.findCards(doc, SEARCH_URL)) {
			const anchor = adapter.cardAnchor(card.element);
			expect(anchor).not.toBeNull();
			expect(card.element.contains(anchor)).toBe(true);
		}
	});

	test.each([
		["9000000000000001", "Canapé cuir De Sede comme neuf"],
		["9000000000000003", "A donner"],
		[
			"9000000000000004",
			"Golf GTI 8 clubsport 2021 full option 122350km prix fixe pas d’échange",
		],
		["9000000000000006", "À vendre plusieurs jeux Wii"],
	])("carte %s : dernier élément du titre", (id, title) => {
		const anchor = adapter.cardAnchor(cardOf(grid(), id));
		expect(anchor?.children.length).toBe(0);
		expect(anchor?.textContent?.replace(/\s+/g, " ").trim()).toBe(title);
	});

	test("carte sans texte : la carte elle-même", () => {
		const card = cardOf(grid(), GRID_IDS[0] as string);
		for (const span of card.querySelectorAll('span[dir="auto"]')) span.remove();
		expect(adapter.cardAnchor(card)).toBe(card);
	});
});

describe("facebookAdapter : annonce d'une carte (listingFromCard)", () => {
	test("carte complète : titre, prix, lieu, première image", () => {
		expect(cardListing(grid(), "9000000000000001")).toEqual({
			site: "facebook.com",
			externalId: "9000000000000001",
			url: "https://www.facebook.com/marketplace/item/9000000000000001/",
			title: "Canapé cuir De Sede comme neuf",
			description: "",
			price: { amountCents: 850000, currency: "EUR" },
			priceType: "fixed",
			location: { city: "Bruxelles", region: "BRU", country: "BE" },
			images: ["https://images.example/fb/11.jpg"],
			seller: {},
		});
	});

	test("GRATUIT : free, sans montant", () => {
		const listing = cardListing(grid(), "9000000000000003");
		expect(listing.priceType).toBe("free");
		expect(listing.price).toBeNull();
	});

	test("€ 1 234 : 123400 centimes", () => {
		const listing = cardListing(grid(), "9000000000000006");
		expect(listing.price?.amountCents).toBe(123400);
		expect(listing.priceType).toBe("fixed");
		expect(listing.location).toEqual({
			city: "Antwerpen",
			region: "VLG",
			country: "BE",
		});
	});

	test("€ 0 : prix fixe à 0, comme sur la fiche", () => {
		expect(cardListing(grid(), "9000000000000005")).toMatchObject({
			price: { amountCents: 0, currency: "EUR" },
			priceType: "fixed",
		});
	});

	test("prix barré : le prix actuel, pas l'ancien", () => {
		const listing = cardListing(grid(), "9000000000000004");
		expect(listing.price?.amountCents).toBe(2350000);
		expect(listing.title).toBe(
			"Golf GTI 8 clubsport 2021 full option 122350km prix fixe pas d’échange",
		);
		expect(listing.images).toEqual(["https://images.example/fb/14.jpg"]);
	});

	test("les 6 cartes : description vide, vendeur vide", () => {
		const doc = grid();
		for (const id of GRID_IDS) {
			const listing = cardListing(doc, id);
			expect(listing.description).toBe("");
			expect(listing.seller).toEqual({});
		}
	});

	test("prix illisible : unknown, sans montant", () => {
		const doc = grid();
		const card = cardOf(doc, "9000000000000002");
		const price = card.querySelector('span[dir="auto"]') as Element;
		price.textContent = "Prix sur demande";
		const listing = adapter.listingFromCard?.(card, SEARCH_URL);
		expect(listing?.price).toBeNull();
		expect(listing?.priceType).toBe("unknown");
		// La ligne illisible reste celle du prix : le titre ne glisse pas.
		expect(listing?.title).toBe("Garmin Forerunner 945");
		expect(listing?.location).toEqual({
			city: "Liège",
			region: "WAL",
			country: "BE",
		});
	});

	test("sans ligne de prix : titre et lieu lus, prix inconnu", () => {
		const doc = grid();
		const card = cardOf(doc, "9000000000000002");
		card.querySelector('span[dir="auto"]')?.remove();
		expect(adapter.listingFromCard?.(card, SEARCH_URL)).toMatchObject({
			title: "Garmin Forerunner 945",
			price: null,
			priceType: "unknown",
			location: { city: "Liège", region: "WAL", country: "BE" },
		});
	});

	test("sans image http(s) : aucune image", () => {
		const doc = grid();
		const card = cardOf(doc, "9000000000000002");
		card.querySelector("img")?.setAttribute("src", "data:image/gif;base64,R0");
		expect(adapter.listingFromCard?.(card, SEARCH_URL)?.images).toEqual([]);
	});

	test("sans titre : null", () => {
		const doc = grid();
		const card = cardOf(doc, "9000000000000002");
		const texts = [...card.querySelectorAll('span[dir="auto"]')];
		for (const span of texts.slice(1)) span.remove();
		expect(adapter.listingFromCard?.(card, SEARCH_URL)).toBeNull();
	});

	test("lien hors fiche ou site inconnu : null", () => {
		const doc = grid();
		const card = cardOf(doc, "9000000000000002");
		expect(
			adapter.listingFromCard?.(
				card,
				new URL("https://m.facebook.com/marketplace/brussels/"),
			),
		).toBeNull();
		card.setAttribute("href", "https://www.facebook.com/marketplace/brussels/");
		expect(adapter.listingFromCard?.(card, SEARCH_URL)).toBeNull();
	});
});
