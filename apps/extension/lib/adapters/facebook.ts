import {
	normalizeText,
	parseFacebookJoinYear,
	parsePriceText,
} from "../listing/parse";
import type { Listing, PageType, Site } from "../listing/types";
import type { ExtractResult, MarketplaceAdapter } from "./types";

const SITES: Site[] = ["facebook.com"];

const ITEM_PATH_RE = /^\/marketplace\/item\/(\d+)/;
const MARKETPLACE_PATH_RE = /^\/marketplace(?:\/|$)/;
// Sections de Marketplace qui ne sont ni une fiche ni une liste d'annonces.
const NON_SEARCH_SECTIONS = new Set([
	"item",
	"profile",
	"you",
	"inbox",
	"create",
]);

const PROFILE_LINK = 'a[href*="/marketplace/profile/"]';
const PROFILE_ID_RE = /\/marketplace\/profile\/(\d+)/;
const LOCATION_LINK = 'a[href^="https://www.facebook.com/marketplace/"]';
const POSTED_LINE_RE = /^(Publié|Listed|Geplaatst)\b/i;
const BELGIAN_REGIONS = new Set(["WAL", "BRU", "VLG"]);

const CONDITION_LABEL_RE = /^(État|Condition|Staat)$/i;
const DETAILS_TITLE_RE = /^(Détails|Details|Beschrijving)$/i;
const PHOTO_ALT_PREFIXES = [
	"Photo de produit de ",
	"Product photo of ",
	"Productfoto van ",
];
const JOIN_YEAR_RE = /Facebook\D{0,20}((?:19|20)\d{2})/;

/** Les pages Facebook portent leur texte dans des `span[dir="auto"]`. */
const TEXT = 'span[dir="auto"]';

function str(v: string | null | undefined): string | undefined {
	return v?.trim() ? v.trim() : undefined;
}

function textOf(el: Element | null | undefined): string | undefined {
	return str(normalizeText(el?.textContent ?? ""));
}

function idOf(url: URL): string | null {
	return ITEM_PATH_RE.exec(url.pathname)?.[1] ?? null;
}

function siteOf(url: URL): Site | null {
	const { hostname } = url;
	return SITES.find((d) => hostname === d || hostname === `www.${d}`) ?? null;
}

function pageType(url: URL): PageType {
	if (idOf(url)) return "listing";
	if (!MARKETPLACE_PATH_RE.test(url.pathname)) return "other";
	const section = url.pathname.split("/")[2] ?? "";
	return NON_SEARCH_SECTIONS.has(section) ? "other" : "search";
}

function isListingContainer(el: Element): boolean {
	return (
		el.querySelector("h1") !== null && el.querySelector(PROFILE_LINK) !== null
	);
}

/**
 * La fiche en modale coexiste avec la grille sous `[role="main"]` : le
 * dialogue complet passe d'abord, la page directe ensuite.
 */
function findRoot(doc: Document, url: URL): Element | null {
	if (!idOf(url)) return null;
	for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
		if (isListingContainer(dialog)) return dialog;
	}
	const main = doc.querySelector('[role="main"]');
	return main && isListingContainer(main) ? main : null;
}

/**
 * Premier `span[dir="auto"]` qui suit `from` dans le document, sans sortir de
 * `root`. On remonte de `from` vers `root` et on lit les frères suivants à
 * chaque niveau. Un bouton (carte du lieu, actions) arrête la recherche : ce
 * qui vient après n'appartient plus au bloc lu.
 */
function nextText(from: Element, root: Element): Element | undefined {
	for (
		let el: Element | null = from;
		el && el !== root;
		el = el.parentElement
	) {
		for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
			const text = sib.matches(TEXT) ? sib : sib.querySelector(TEXT);
			if (text) return text;
			if (
				sib.matches('[role="button"]') ||
				sib.querySelector('[role="button"]')
			)
				return undefined;
		}
	}
	return undefined;
}

function findText(
	root: Element,
	re: RegExp,
	selector = TEXT,
): Element | undefined {
	return [...root.querySelectorAll(selector)].find((el) =>
		re.test(textOf(el) ?? ""),
	);
}

/** Bloc du prix : le premier frère qui suit le `h1` (ou un de ses ancêtres). */
function readPrice(
	h1: Element,
	root: Element,
): ReturnType<typeof parsePriceText> {
	for (let el: Element | null = h1; el && el !== root; el = el.parentElement) {
		const block = el.nextElementSibling;
		if (block)
			return parsePriceText(block.querySelector(TEXT)?.textContent ?? "");
	}
	return null;
}

/** « Namur, WAL » dans la ligne « Publié il y a … dans <lien> ». */
function readLocation(root: Element): Listing["location"] {
	const link = [...root.querySelectorAll(LOCATION_LINK)].find((a) => {
		if (/\/marketplace\/(profile|item)\//.test(a.getAttribute("href") ?? ""))
			return false;
		const line = a.closest('[dir="auto"]');
		return (
			line !== null &&
			(line.querySelector("abbr") !== null ||
				POSTED_LINE_RE.test(textOf(line) ?? ""))
		);
	});
	const text = textOf(link);
	if (!text) return {};
	const comma = text.lastIndexOf(",");
	const city = str(comma < 0 ? text : text.slice(0, comma));
	const region = comma < 0 ? undefined : str(text.slice(comma + 1));
	const location: Listing["location"] = {};
	if (city) location.city = city;
	if (region) location.region = region;
	if (region && BELGIAN_REGIONS.has(region)) location.country = "BE";
	return location;
}

/** Garde les sauts de ligne de la description, espaces normalisés par ligne. */
function multiline(el: Element): string {
	return (el.textContent ?? "")
		.split("\n")
		.map(normalizeText)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function readDetails(root: Element): {
	condition?: string;
	description?: string;
} {
	const label = findText(root, CONDITION_LABEL_RE);
	const value = label ? nextText(label, root) : undefined;
	const condition = textOf(value);
	// Sans ligne État, la description suit directement le titre « Détails ».
	const after = value ?? findText(root, DETAILS_TITLE_RE, "h2");
	const descriptionEl = after ? nextText(after, root) : undefined;
	const description = descriptionEl ? str(multiline(descriptionEl)) : undefined;
	return { condition, description };
}

function readImages(root: Element): string[] {
	const selector = PHOTO_ALT_PREFIXES.map((p) => `img[alt^="${p}"]`).join(",");
	const images: string[] = [];
	for (const img of root.querySelectorAll(selector)) {
		const src = img.getAttribute("src") ?? "";
		if (!/^https?:\/\//i.test(src) || images.includes(src)) continue;
		images.push(src);
	}
	return images;
}

function readSeller(root: Element, url: URL, now: Date): Listing["seller"] {
	const links = [...root.querySelectorAll(PROFILE_LINK)];
	const id = links
		.map((a) => PROFILE_ID_RE.exec(a.getAttribute("href") ?? "")?.[1])
		.find((v) => v !== undefined);
	const name = links
		.map((a) => str(a.getAttribute("aria-label")))
		.find((v) => v !== undefined);
	const joinLine = findText(root, JOIN_YEAR_RE, `[role="listitem"] ${TEXT}`);
	const year = JOIN_YEAR_RE.exec(textOf(joinLine) ?? "")?.[1];
	return {
		id,
		name,
		profileUrl: id ? `${url.origin}/marketplace/profile/${id}/` : undefined,
		accountAgeMonths: year
			? (parseFacebookJoinYear(year, now) ?? undefined)
			: undefined,
		reviewCount: undefined,
		rating: undefined,
		otherListingsCount: undefined,
		verified: undefined,
	};
}

function extract(doc: Document, url: URL, now: Date): ExtractResult | null {
	const site = siteOf(url);
	const externalId = idOf(url);
	const root = findRoot(doc, url);
	if (!site || !externalId || !root) return null;

	const h1 = root.querySelector("h1");
	const title = textOf(h1);
	if (!h1 || !title) return null;

	const missing: string[] = [];

	const priceInfo = readPrice(h1, root);
	if (!priceInfo) missing.push("price");

	const { condition, description } = readDetails(root);
	if (!description) missing.push("description");

	const images = readImages(root);
	if (!images.length) missing.push("images");

	const location = readLocation(root);
	if (!location.city) missing.push("location.city");
	if (!location.country) missing.push("location.country");

	const sellerFields = readSeller(root, url, now);
	for (const [key, value] of Object.entries(sellerFields)) {
		if (value === undefined) missing.push(`seller.${key}`);
	}
	const seller = Object.fromEntries(
		Object.entries(sellerFields).filter(([, value]) => value !== undefined),
	) as Listing["seller"];

	const listing: Listing = {
		site,
		externalId,
		url: `${url.origin}${url.pathname}`,
		title,
		description: description ?? "",
		price: priceInfo?.price ?? null,
		priceType: priceInfo?.priceType ?? "unknown",
		location,
		images,
		seller,
	};
	if (condition) listing.condition = condition;
	else missing.push("condition");
	// Ni catégorie ni date exacte dans le DOM (seulement « il y a une semaine »).
	missing.push("category", "postedAt");

	return { listing, missing };
}

/** `clock` donne la date du jour pour l'ancienneté « A rejoint Facebook en AAAA ». */
export function createFacebookAdapter(
	clock: () => Date = () => new Date(),
): MarketplaceAdapter {
	return {
		id: "facebook",
		sites: SITES,
		siteOf,
		pageType(url) {
			return pageType(url);
		},
		extractListing(doc, url) {
			return extract(doc, url, clock());
		},
		listingRoot(doc, url) {
			return findRoot(doc, url);
		},
		badgeAnchor(root) {
			return root.querySelector("h1");
		},
	};
}

export const facebookAdapter = createFacebookAdapter();
