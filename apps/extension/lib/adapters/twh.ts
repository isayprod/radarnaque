import {
	normalizeText,
	parseAccountAge,
	parsePriceText,
} from "../listing/parse";
import type { Listing, PageType, Site } from "../listing/types";
import { foldText } from "../rules/keywords";
import type { CardRef, ExtractResult, MarketplaceAdapter } from "./types";

const SITES: Site[] = ["2ememain.be", "2dehands.be"];

const LISTING_PATH_RE = /^\/v\/[^/]+\/[^/]+\/(m\d+)/i;
/**
 * Affectation de `__CONFIG__`, n'importe où dans le script : sur les vraies pages,
 * `window.__HEADER_CONFIG__ = …;` la précède dans le même `<script>`.
 */
const CONFIG_ASSIGN_RE = /\bwindow\.__CONFIG__\s*=\s*/;
/** Hôtes de nos interfaces injectées (pastille, icônes) : jamais lus comme contenu de la page. */
const OWN_HOST_PREFIX = "radarnaque-";
/** Pages de résultats : catégorie (`/l/…`) ou recherche libre (`/q/…`). */
const SEARCH_PATH_RE = /^\/(l|q)\//i;
/**
 * Lien de carte : repéré par le motif d'URL de la fiche, pas par les classes du
 * site (hachées). Une annonce professionnelle (`a…`), dont la fiche n'est pas
 * encore prise en charge, a un id `a<chiffres>`, que `LISTING_PATH_RE` écarte.
 */
const CARD_LINK = 'a[href*="/v/"]';

/** Des `Map` : une clé lue sur la page (« constructor »…) ne tombe jamais sur le prototype. */
const PRICE_TYPES = new Map<string, Listing["priceType"]>([
	["FIXED", "fixed"],
	["MIN_BID", "bidding"],
	["FAST_BID", "bidding"],
	["FREE_BID", "bidding"],
	["FREE", "free"],
	["SEE_DESCRIPTION", "see_description"],
	["ON_REQUEST", "on_request"],
	// « N.o.t.k. » (nader overeen te komen) : « à convenir », donc sur demande.
	["NOTK", "on_request"],
	["EXCHANGE", "exchange"],
	["RESERVED", "reserved"],
]);

/**
 * Libellé affiché à la place du prix, plié par `foldText` (casse, accents) :
 * repli quand `__CONFIG__` ne donne pas de type de prix exploitable.
 */
const PRICE_LABELS = new Map<string, Listing["priceType"]>([
	["prix sur demande", "on_request"],
	["prijs op aanvraag", "on_request"],
	["voir description", "see_description"],
	["zie omschrijving", "see_description"],
	["a convenir", "on_request"],
	["n.o.t.k.", "on_request"],
	["echange", "exchange"],
	["ruilen", "exchange"],
	["reserve", "reserved"],
	["gereserveerd", "reserved"],
]);

/**
 * Valeurs de `sellerType` (R7), en majuscules. Liste fermée : une valeur inconnue
 * reste indéterminée plutôt que de valoir « professionnel » par défaut. La valeur
 * réelle d'un professionnel reste à relever sur une vraie annonce.
 */
const PRIVATE_SELLER_TYPES = new Set(["CONSUMER"]);
const PROFESSIONAL_SELLER_TYPES = new Set([
	"PROFESSIONAL",
	"TRADER",
	"BUSINESS",
	"DEALER",
	"COMPANY",
	"PRO",
]);

/** Lien de la section vendeur qui ne s'affiche que pour un professionnel. */
const WEBSITE_LINK_LABELS = new Set([
	"visiter le site internet",
	"bekijk website",
]);
/** Sections du vendeur : la sidebar et le bloc `#vendeur` (pas l'en-tête du site). */
const SELLER_SCOPES = ["#seller-sidebar-root", "#vendeur"];

const CONDITION_LABEL_RE = /^(État|Conditie|Staat)$/i;
const VERIFICATION_TITLE_RE = /^(Vérification|Verificatie|Verification)/i;
// Toute négation l'emporte : « Rien n'a été vérifié », « non vérifié », « niet gecontroleerd ».
const NEGATION_RE = /\b(rien|pas|non|niet|niets|geen)\b/i;
const VERIFIED_RE = /a été vérifiée?|is (gecontroleerd|geverifieerd)/i;
const REVIEWS_HREF_RE = /\/experiences\/user-reviews\/([^/?#]+)/;
const OTHER_LISTINGS_RE = /(\d+)\s*(annonces?|advertenties?)/i;
const RATING_RE = /(\d+(?:[.,]\d+)?)/;

/**
 * Sous-ensemble lu de `window.__CONFIG__.listing`. Tout est optionnel et
 * vérifié à la lecture : la page peut changer de forme.
 */
interface TwhConfigListing {
	itemId?: unknown;
	title?: unknown;
	priceInfo?: { priceCents?: unknown; priceType?: unknown };
	category?: { fullName?: unknown };
	stats?: { since?: unknown };
	gallery?: { imageUrls?: unknown };
	seller?: {
		id?: unknown;
		name?: unknown;
		sellerProfileUrl?: unknown;
		activeSinceDiff?: unknown;
		/** `CONSUMER` pour un particulier, autre chose pour un professionnel. */
		sellerType?: unknown;
		location?: { cityName?: unknown; countryAbbreviation?: unknown };
	};
}

interface JsonLdProduct {
	"@type"?: unknown;
	name?: unknown;
	sku?: unknown;
	image?: unknown;
	offers?: { price?: unknown };
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function idOf(url: URL): string | null {
	return LISTING_PATH_RE.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
}

/** Le content script ne voit pas `window` de la page : on parse le texte du script. */
function readConfigListing(doc: Document): TwhConfigListing | null {
	for (const script of doc.querySelectorAll("script:not([src])")) {
		const text = script.textContent ?? "";
		const match = CONFIG_ASSIGN_RE.exec(text);
		if (!match) continue;
		const json = jsonObjectAt(text, match.index + match[0].length);
		if (json === null) return null;
		try {
			const config = JSON.parse(json) as { listing?: TwhConfigListing };
			return config?.listing && typeof config.listing === "object"
				? config.listing
				: null;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Texte de l'objet JSON qui commence à `start` (après les espaces), accolades
 * équilibrées hors des chaînes ; `null` s'il n'y en a pas ou s'il n'est pas fermé.
 * Ce qui suit l'objet dans le script (autre affectation) est ignoré.
 */
function jsonObjectAt(text: string, start: number): string | null {
	let i = start;
	while (i < text.length && /\s/.test(text[i] ?? "")) i++;
	if (text[i] !== "{") return null;
	let depth = 0;
	let inString = false;
	for (let j = i; j < text.length; j++) {
		const c = text[j];
		if (inString) {
			if (c === "\\") j++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return text.slice(i, j + 1);
	}
	return null;
}

/** Élément qui suit `el`, en sautant nos propres interfaces injectées (la pastille). */
function nextPageElement(el: Element | null | undefined): Element | null {
	let next = el?.nextElementSibling ?? null;
	while (next?.tagName.toLowerCase().startsWith(OWN_HOST_PREFIX))
		next = next.nextElementSibling;
	return next;
}

function readJsonLdProduct(doc: Document): JsonLdProduct | null {
	for (const script of doc.querySelectorAll(
		'script[type="application/ld+json"]',
	)) {
		try {
			const data = JSON.parse(script.textContent ?? "") as unknown;
			for (const item of Array.isArray(data) ? data : [data]) {
				if (item && (item as JsonLdProduct)["@type"] === "Product")
					return item as JsonLdProduct;
			}
		} catch {
			// bloc JSON-LD invalide : on passe au suivant
		}
	}
	return null;
}

function absoluteImage(src: string): string | null {
	// `$_#` : gabarit de taille de la galerie, remplacé par la taille du JSON-LD.
	const url = src.replace("$_#", "$_86");
	if (url.startsWith("//")) return `https:${url}`;
	if (url.startsWith("https://")) return url;
	return null;
}

/**
 * Un tableau vide est une vraie réponse (zéro photo). null : pas de tableau, ou
 * des entrées toutes illisibles.
 */
function imagesOf(list: unknown): string[] | null {
	if (!Array.isArray(list)) return null;
	const images = list
		.map((src) => (typeof src === "string" ? absoluteImage(src) : null))
		.filter((src): src is string => src !== null);
	return images.length || !list.length ? images : null;
}

function priceFromConfig(info: TwhConfigListing["priceInfo"]): {
	price: Listing["price"];
	priceType: Listing["priceType"];
} | null {
	const type = str(info?.priceType);
	if (!type) return null;
	const priceType = PRICE_TYPES.get(type) ?? "unknown";
	const cents = info?.priceCents;
	const hasAmount =
		typeof cents === "number" &&
		Number.isInteger(cents) &&
		cents >= 0 &&
		(priceType === "fixed" || (priceType === "bidding" && cents > 0));
	return {
		price: hasAmount ? { amountCents: cents, currency: "EUR" } : null,
		priceType,
	};
}

/** Type de prix lu sur le libellé affiché (« Prix sur demande »…), sans montant. */
function priceFromLabel(text: string): {
	price: Listing["price"];
	priceType: Listing["priceType"];
} | null {
	const priceType = PRICE_LABELS.get(foldText(text));
	return priceType ? { price: null, priceType } : null;
}

function priceFromProduct(product: JsonLdProduct | null): Listing["price"] {
	const raw = product?.offers?.price;
	const euros = typeof raw === "number" ? raw : Number(str(raw) ?? Number.NaN);
	if (!Number.isFinite(euros) || euros < 0) return null;
	return { amountCents: Math.round(euros * 100), currency: "EUR" };
}

function sidebarTitle(root: ParentNode): Element | null {
	return root.querySelector("#seller-sidebar-root header h1");
}

/** Texte avec les sauts de ligne de `<br>` et des blocs, espaces normalisés par ligne. */
function textWithBreaks(el: Element): string {
	const parts: string[] = [];
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const tag = (node as Element).tagName.toLowerCase();
		if (tag === "br") {
			parts.push("\n");
			return;
		}
		const block = tag === "p" || tag === "div" || tag === "li";
		if (block) parts.push("\n");
		for (const child of node.childNodes) walk(child);
		if (block) parts.push("\n");
	};
	for (const child of el.childNodes) walk(child);
	return parts
		.join("")
		.split("\n")
		.map(normalizeText)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function readCondition(doc: Document): string | undefined {
	// Le bloc des caractéristiques est voisin de `#listing-root`, pas dedans.
	const scope = doc.querySelector("main") ?? doc.body;
	for (const el of scope.querySelectorAll("*")) {
		if (el.children.length > 0) continue;
		if (!CONDITION_LABEL_RE.test(normalizeText(el.textContent ?? ""))) continue;
		return str(normalizeText(el.nextElementSibling?.textContent ?? ""));
	}
	return undefined;
}

/**
 * Avis du vendeur : seulement dans la sidebar ou `#vendeur` (l'en-tête du site
 * porte les liens du visiteur), et pour l'id du vendeur quand il est connu.
 */
function readReviews(
	doc: Document,
	sellerId: string | undefined,
): { count?: number; rating?: number } {
	const link = ["#seller-sidebar-root", "#vendeur"]
		.flatMap((scope) => [
			...doc.querySelectorAll(`${scope} a[href*="/experiences/user-reviews/"]`),
		])
		.find((a) => {
			const id = REVIEWS_HREF_RE.exec(a.getAttribute("href") ?? "")?.[1];
			return sellerId === undefined || id === sellerId;
		});
	if (!link) return {};
	const count = /\d+/.exec(normalizeText(link.textContent ?? ""))?.[0];
	const ratingText = link.previousElementSibling?.textContent ?? "";
	const rating = RATING_RE.exec(normalizeText(ratingText))?.[1];
	const ratingValue = rating ? Number(rating.replace(",", ".")) : Number.NaN;
	return {
		count: count === undefined ? undefined : Number(count),
		rating: ratingValue >= 0 && ratingValue <= 5 ? ratingValue : undefined,
	};
}

/**
 * Particulier ou professionnel. Un `sellerType` de `__CONFIG__` connu (R7) fait
 * foi, même face à un lien vers un site (R3 : la plateforme l'attribue, le vendeur
 * ne peut pas acheter le traitement « professionnel » en ajoutant un lien). Absent
 * ou inconnu : un lien « Visiter le site internet » dans la section vendeur
 * indique un professionnel. Sinon : indéterminé.
 */
function readSellerKind(
	sellerType: unknown,
	doc: Document,
): Listing["seller"]["sellerKind"] {
	const type = str(sellerType)?.toUpperCase();
	if (type && PRIVATE_SELLER_TYPES.has(type)) return "private";
	if (type && PROFESSIONAL_SELLER_TYPES.has(type)) return "professional";
	const hasWebsite = SELLER_SCOPES.some((scope) =>
		[...doc.querySelectorAll(`${scope} a`)].some((a) =>
			WEBSITE_LINK_LABELS.has(foldText(a.textContent ?? "")),
		),
	);
	return hasWebsite ? "professional" : undefined;
}

function readVerified(doc: Document): boolean | undefined {
	for (const item of doc.querySelectorAll("#vendeur li")) {
		const text = normalizeText(item.textContent ?? "");
		if (!VERIFICATION_TITLE_RE.test(text)) continue;
		const body = text.replace(VERIFICATION_TITLE_RE, "");
		if (NEGATION_RE.test(body)) return false;
		if (VERIFIED_RE.test(body)) return true;
		return undefined;
	}
	return undefined;
}

/** Compte dans l'en-tête du carrousel (bloc du premier titre), pas dans les cartes. */
function readOtherListingsCount(doc: Document): number | undefined {
	const heading = doc.querySelector(
		"#seller-other-items-root :is(h1, h2, h3, h4, h5, h6)",
	);
	const header = heading?.parentElement;
	const m = OTHER_LISTINGS_RE.exec(normalizeText(header?.textContent ?? ""));
	return m?.[1] ? Number(m[1]) : undefined;
}

/** URL du profil, seulement si elle reste sur le site de l'annonce. */
function sameOriginUrl(
	path: string | undefined,
	base: URL,
): string | undefined {
	if (!path) return undefined;
	try {
		const u = new URL(path, base.origin);
		return u.origin === base.origin ? u.href : undefined;
	} catch {
		return undefined;
	}
}

function siteOf(url: URL): Site | null {
	const { hostname } = url;
	return SITES.find((d) => hostname === d || hostname === `www.${d}`) ?? null;
}

function isListingPage(url: URL, doc: Document): boolean {
	return (
		idOf(url) !== null && doc.getElementById("seller-sidebar-root") !== null
	);
}

/** Id de la fiche visée par `href`, si le lien reste sur 2ememain ou 2dehands. */
function cardIdOfHref(href: string | null, pageUrl: URL): string | null {
	if (!href) return null;
	try {
		const url = new URL(href, pageUrl.origin);
		return siteOf(url) ? idOf(url) : null;
	} catch {
		return null;
	}
}

/**
 * Une carte est l'élément de liste qui contient un lien de fiche ; elle
 * répète ce lien dans ses trois mises en page (bureau, tablette, mobile), d'où
 * la déduplication par id et par élément. Rien hors page de résultats. Les
 * cartes sont produites à la demande : `pageType` s'arrête à la première.
 */
function* cardsOf(root: ParentNode, pageUrl: URL): Generator<CardRef> {
	if (!siteOf(pageUrl) || !SEARCH_PATH_RE.test(pageUrl.pathname)) return;
	const seen = new Set<string>();
	const used = new Set<Element>();
	for (const link of root.querySelectorAll(CARD_LINK)) {
		const href = link.getAttribute("href");
		const id = cardIdOfHref(href, pageUrl);
		if (!href || !id || seen.has(id)) continue;
		// Hors d'un élément de liste (lien interne d'une fiche, etc.) : pas une carte.
		const element = link.closest('li, [role="listitem"]');
		if (!element || used.has(element)) continue;
		seen.add(id);
		used.add(element);
		const { pathname } = new URL(href, pageUrl.origin);
		yield {
			element,
			externalId: id,
			// Hôte de la page (même origine pour `fetch`), sans paramètres de suivi.
			url: `${pageUrl.origin}${pathname}`,
		};
	}
}

function findCards(root: ParentNode, pageUrl: URL): CardRef[] {
	return [...cardsOf(root, pageUrl)];
}

function pageType(url: URL, doc: Document): PageType {
	if (isListingPage(url, doc)) return "listing";
	return cardsOf(doc, url).next().done ? "other" : "search";
}

/** Variante de mise en page affichée ; sans `checkVisibility`, toutes le sont. */
function isRendered(el: Element): boolean {
	return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/** Premier élément portant du texte propre sous `el`, dans l'ordre du document. */
function firstText(el: Element): Element | null {
	for (const candidate of [el, ...el.querySelectorAll("*")]) {
		const own = [...candidate.childNodes].some(
			(n) =>
				n.nodeType === Node.TEXT_NODE && normalizeText(n.textContent ?? ""),
		);
		if (own) return candidate;
	}
	return null;
}

/**
 * Titre de la carte : dans le lien de couverture affiché (celui qui porte la
 * photo), premier texte hors du bloc photo (favori, texte pour lecteur d'écran).
 */
function cardTitle(card: Element): Element | null {
	const covers = [...card.querySelectorAll("a")].filter((a) =>
		a.querySelector("img"),
	);
	const cover = covers.find(isRendered) ?? covers[0];
	if (!cover) return null;
	for (const part of cover.children) {
		if (part.tagName === "IMG" || part.querySelector("img")) continue;
		const title = firstText(part);
		if (title) return title;
	}
	return null;
}

/** Le titre de la carte, sinon la carte : jamais null. */
function cardAnchor(card: Element): Element {
	return cardTitle(card) ?? card;
}

function extract(doc: Document, url: URL, site: Site): ExtractResult | null {
	const externalId = idOf(url);
	if (!externalId) return null;

	// Après une navigation interne, `__CONFIG__` et le JSON-LD décrivent encore
	// l'annonce précédente : on les ignore si l'id ne correspond pas à l'URL.
	const rawConfig = readConfigListing(doc);
	const config =
		str(rawConfig?.itemId)?.toLowerCase() === externalId ? rawConfig : null;
	const rawProduct = readJsonLdProduct(doc);
	const sku = str(rawProduct?.sku)?.toLowerCase();
	const product = sku === externalId ? rawProduct : null;

	const h1 = sidebarTitle(doc) ?? doc.querySelector("h1");
	const title =
		str(config?.title) ??
		str(normalizeText(h1?.textContent ?? "")) ??
		str(product?.name);
	if (!title) return null;

	const missing: string[] = [];

	// Un type connu de `__CONFIG__` fait foi ; un type absent ou inconnu laisse
	// le libellé affiché à la place du prix (« Prix sur demande »…) le préciser.
	// La pastille est insérée juste après le titre : elle n'est jamais lue comme prix.
	const priceText = nextPageElement(h1)?.textContent ?? "";
	const configPrice = priceFromConfig(config?.priceInfo);
	const priceInfo =
		(configPrice?.priceType === "unknown" ? null : configPrice) ??
		priceFromLabel(priceText) ??
		configPrice ??
		parsePriceText(priceText) ??
		(() => {
			const price = priceFromProduct(product);
			return price ? { price, priceType: "unknown" as const } : null;
		})();
	if (!priceInfo) missing.push("price");

	const descriptionEl = doc.querySelector('[data-collapsable="description"]');
	const description = descriptionEl ? textWithBreaks(descriptionEl) : "";
	if (!descriptionEl) missing.push("description");

	// Un `__CONFIG__` valide fait foi, même avec zéro photo : pas de repli.
	const configImages = imagesOf(config?.gallery?.imageUrls);
	const fallbackImages = configImages ? null : imagesOf(product?.image);
	const images = configImages ?? fallbackImages ?? [];
	if (!configImages && !fallbackImages?.length) missing.push("images");

	const seller = config?.seller;
	const location: Listing["location"] = {};
	const city = str(seller?.location?.cityName);
	const country = str(seller?.location?.countryAbbreviation);
	if (city) location.city = city;
	if (country) location.country = country;
	if (!city) missing.push("location.city");
	if (!country) missing.push("location.country");

	const rawSellerId = seller?.id;
	const sellerId =
		typeof rawSellerId === "number" || typeof rawSellerId === "string"
			? str(String(rawSellerId))
			: undefined;
	const reviews = readReviews(doc, sellerId);
	const sellerFields: Listing["seller"] = {
		id: sellerId,
		name: str(seller?.name),
		profileUrl: sameOriginUrl(str(seller?.sellerProfileUrl), url),
		accountAgeMonths:
			parseAccountAge(str(seller?.activeSinceDiff) ?? "") ?? undefined,
		reviewCount: reviews.count,
		rating: reviews.rating,
		otherListingsCount: readOtherListingsCount(doc),
		verified: readVerified(doc),
		sellerKind: readSellerKind(seller?.sellerType, doc),
	};
	for (const [key, value] of Object.entries(sellerFields)) {
		if (value === undefined) missing.push(`seller.${key}`);
	}
	const listingSeller = Object.fromEntries(
		Object.entries(sellerFields).filter(([, value]) => value !== undefined),
	) as Listing["seller"];

	const listing: Listing = {
		site,
		externalId,
		url: `${url.origin}${url.pathname}`,
		title,
		description,
		price: priceInfo?.price ?? null,
		priceType: priceInfo?.priceType ?? "unknown",
		location,
		images,
		seller: listingSeller,
	};
	const category = str(config?.category?.fullName);
	const condition = readCondition(doc);
	const postedAt = str(config?.stats?.since);
	if (category) listing.category = category;
	else missing.push("category");
	if (condition) listing.condition = condition;
	else missing.push("condition");
	if (postedAt) listing.postedAt = postedAt;
	else missing.push("postedAt");

	return { listing, missing };
}

export const twhAdapter: MarketplaceAdapter = {
	id: "twh",
	sites: SITES,
	siteOf,
	pageType,
	extractListing(doc, url) {
		const site = siteOf(url);
		if (!site || !isListingPage(url, doc)) return null;
		return extract(doc, url, site);
	},
	listingRoot(doc, url) {
		return isListingPage(url, doc) ? doc.body : null;
	},
	badgeAnchor(root) {
		return sidebarTitle(root) ?? root.querySelector("h1");
	},
	findCards,
	cardAnchor,
};
