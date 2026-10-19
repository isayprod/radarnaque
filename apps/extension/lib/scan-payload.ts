import type { components, ScanIn } from "@radarnaque/shared";
import type { Listing } from "./listing/types";
import type { ScanRequest } from "./messages";
import type { Signal } from "./rules/rules";

type ListingIn = components["schemas"]["ListingIn"];
type SellerFactsIn = components["schemas"]["SellerFactsIn"];
type LocationIn = components["schemas"]["LocationIn"];
type SignalIn = components["schemas"]["SignalIn"];

/**
 * Bornes d'entrée de `POST /api/scans` (contraintes globales). On tronque côté client
 * pour que le serveur ne réponde jamais `422 invalid_listing` sur une annonce longue.
 */
export const BOUNDS = {
	title: 300,
	description: 5000,
	images: 10,
	category: 200,
	condition: 100,
	postedAt: 64,
	/** `location.city`, `location.region` et `location.country`, chacun. */
	location: 100,
	signals: 20,
	paramEntries: 10,
	paramKey: 40,
	paramString: 200,
} as const;

/** Annonce impossible à envoyer (titre vide) : le scan échoue sans appel réseau. */
export class ScanPayloadError extends Error {
	readonly code: "invalid_listing";

	constructor(code: "invalid_listing") {
		super(code);
		this.name = "ScanPayloadError";
		this.code = code;
	}
}

/**
 * Tronque en points de code, comme le serveur compte les longueurs : un emoji
 * (paire de substitution) n'est jamais coupé en deux.
 */
function cut(value: string, max: number): string {
	const chars = Array.from(value);
	return chars.length <= max ? value : chars.slice(0, max).join("");
}

/** Faits sur le vendeur uniquement : `id`, `name` et `profileUrl` restent dans le navigateur. */
function sellerFacts(seller: Listing["seller"]): SellerFactsIn {
	const out: SellerFactsIn = {};
	if (seller.accountAgeMonths !== undefined) {
		out.accountAgeMonths = {
			min: seller.accountAgeMonths.min,
			max: seller.accountAgeMonths.max,
		};
	}
	if (seller.reviewCount !== undefined) out.reviewCount = seller.reviewCount;
	if (seller.rating !== undefined) out.rating = seller.rating;
	if (seller.otherListingsCount !== undefined) {
		out.otherListingsCount = seller.otherListingsCount;
	}
	if (seller.verified !== undefined) out.verified = seller.verified;
	if (seller.sellerKind !== undefined) out.sellerKind = seller.sellerKind;
	return out;
}

function location(loc: Listing["location"]): LocationIn {
	const out: LocationIn = {};
	if (loc.city !== undefined) out.city = cut(loc.city, BOUNDS.location);
	if (loc.region !== undefined) out.region = cut(loc.region, BOUNDS.location);
	if (loc.country !== undefined) {
		out.country = cut(loc.country, BOUNDS.location);
	}
	return out;
}

/**
 * Paramètres d'un signal acceptés par le serveur : clés de 1 à 40 caractères, chaînes
 * coupées à 200, nombres entiers seulement ; les 10 premières entrées valables.
 */
function params(raw: Signal["params"]): SignalIn["params"] | undefined {
	if (!raw) return undefined;
	const out: Record<string, string | number> = {};
	let count = 0;
	for (const [key, value] of Object.entries(raw)) {
		if (count >= BOUNDS.paramEntries) break;
		const keyLength = Array.from(key).length;
		if (keyLength < 1 || keyLength > BOUNDS.paramKey) continue;
		if (typeof value === "string") {
			out[key] = cut(value, BOUNDS.paramString);
		} else if (Number.isInteger(value)) {
			out[key] = value;
		} else {
			continue;
		}
		count += 1;
	}
	return count > 0 ? out : undefined;
}

function signal(s: Signal): SignalIn {
	const out: SignalIn = { id: s.id, weight: s.weight, severity: s.severity };
	const kept = params(s.params);
	if (kept) out.params = kept;
	return out;
}

/**
 * Point de passage unique vers l'API : retire l'identité du vendeur et applique les
 * bornes d'entrée. Un titre vide (après `trim`) lève `ScanPayloadError("invalid_listing")`.
 */
export function toScanIn(req: ScanRequest): ScanIn {
	const l = req.listing;
	const title = cut(l.title.trim(), BOUNDS.title);
	if (!title) throw new ScanPayloadError("invalid_listing");

	const listing: ListingIn = {
		site: l.site,
		externalId: l.externalId,
		url: l.url,
		title,
		description: cut(l.description, BOUNDS.description),
		price: l.price
			? { amountCents: l.price.amountCents, currency: l.price.currency }
			: null,
		priceType: l.priceType,
		location: location(l.location),
		images: l.images.slice(0, BOUNDS.images),
		seller: sellerFacts(l.seller),
	};
	if (l.category !== undefined) {
		listing.category = cut(l.category, BOUNDS.category);
	}
	if (l.condition !== undefined) {
		listing.condition = cut(l.condition, BOUNDS.condition);
	}
	if (l.postedAt !== undefined) {
		listing.postedAt = cut(l.postedAt, BOUNDS.postedAt);
	}

	const body: ScanIn = {
		listing,
		rules: {
			version: req.rulesVersion,
			signals: req.signals.slice(0, BOUNDS.signals).map(signal),
		},
		scanKind: req.scanKind,
		trigger: req.trigger,
		partial: req.partial,
	};
	// Seulement s'il est demandé : le corps d'un scan ordinaire ne change pas.
	if (req.noCache === true) body.noCache = true;
	return body;
}
