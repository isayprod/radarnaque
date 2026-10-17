import type { AnalysisResult } from "@radarnaque/shared";
import type {
	CardRef,
	ExtractResult,
	MarketplaceAdapter,
} from "../adapters/types";
import type { Listing } from "../listing/types";
import type { BgResponse } from "../messages";
import { evaluate, type UnknownField } from "../rules/score";
import type { AiClient } from "./ai-client";

/** Délai maximal de récupération de la fiche d'une carte. */
const FETCH_TIMEOUT_MS = 10_000;

// Mêmes champs que pour la pastille de fiche (controller.ts) : leur absence
// désactive la règle qui en dépend au lieu de la déclencher.
const UNKNOWN_FIELDS: ReadonlySet<string> = new Set<UnknownField>([
	"description",
	"images",
]);

/** Repli sur la carte : ni description ni toutes les photos. */
const CARD_UNKNOWN: ReadonlySet<UnknownField> = new Set<UnknownField>([
	"description",
	"images",
]);

export interface ScanCardDeps {
	pageUrl: URL;
	adapter: MarketplaceAdapter;
	ai: AiClient;
	fetchPage(url: string): Promise<string>;
}

const fail = (code: string): BgResponse<never> => ({
	ok: false,
	error: { code },
});

/**
 * HTML de la fiche, avec les cookies du site (même origine que la page) ;
 * rejette sur une réponse non `ok`, une redirection vers une autre origine ou
 * au-delà de 10 s.
 */
export async function defaultFetchPage(url: string): Promise<string> {
	const res = await fetch(url, {
		credentials: "include",
		redirect: "follow",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	// Redirection hors du site (connexion, page externe) : ce n'est pas la fiche.
	if (new URL(res.url || url).origin !== new URL(url).origin)
		throw new Error("redirection vers une autre origine");
	return res.text();
}

/** Fiche récupérée puis extraite ; null si la page est illisible ou n'est pas cette annonce. */
async function fetchListing(
	card: CardRef,
	cardUrl: URL,
	deps: ScanCardDeps,
): Promise<ExtractResult | null> {
	try {
		const html = await deps.fetchPage(card.url);
		// DOMParser : document inerte, aucun script de la page n'est exécuté.
		const doc = new DOMParser().parseFromString(html, "text/html");
		const result = deps.adapter.extractListing(doc, cardUrl);
		return result?.listing.externalId === card.externalId ? result : null;
	} catch {
		return null;
	}
}

/**
 * Analyse IA d'une carte de résultats : la fiche est récupérée et lue en
 * entier ; si elle est illisible, l'annonce lue sur la carte est envoyée en
 * `partial`. Jamais de requête hors de l'origine de la page.
 */
export async function scanCard(
	card: CardRef,
	deps: ScanCardDeps,
): Promise<BgResponse<AnalysisResult>> {
	let cardUrl: URL;
	try {
		cardUrl = new URL(card.url);
	} catch {
		return fail("invalid_listing");
	}
	if (cardUrl.origin !== deps.pageUrl.origin) return fail("invalid_listing");

	let listing: Listing;
	let unknown: ReadonlySet<UnknownField>;
	let partial: boolean;
	const extracted = await fetchListing(card, cardUrl, deps);
	if (extracted) {
		listing = extracted.listing;
		unknown = new Set(
			extracted.missing.filter((f): f is UnknownField => UNKNOWN_FIELDS.has(f)),
		);
		partial = false;
	} else {
		const fromCard = deps.adapter.listingFromCard?.(card.element, deps.pageUrl);
		if (!fromCard) return fail("invalid_listing");
		listing = fromCard;
		unknown = CARD_UNKNOWN;
		partial = true;
	}

	const report = evaluate(listing, { unknown });
	return deps.ai.scan({
		listing,
		signals: report.signals,
		rulesVersion: report.rulesVersion,
		scanKind: "text",
		trigger: "card",
		partial,
	});
}
