import type { Listing, PageType, Site } from "../listing/types";

export interface ExtractResult {
	listing: Listing;
	/** Champs non trouvés, pour le debug. */
	missing: string[];
}

/** Carte d'une page de résultats. */
export interface CardRef {
	element: Element;
	externalId: string;
	/** URL absolue de la fiche, sans paramètres de suivi. */
	url: string;
}

export interface MarketplaceAdapter {
	id: "twh" | "facebook";
	sites: Site[];
	siteOf(url: URL): Site | null;
	pageType(url: URL, doc: Document): PageType;
	/** null = pas une fiche exploitable. */
	extractListing(doc: Document, url: URL): ExtractResult | null;
	listingRoot(doc: Document, url: URL): Element | null;
	/** L'UI est insérée APRÈS cet élément. */
	badgeAnchor(root: Element): Element | null;
	/** Cartes sous `root`, dans l'ordre du document ; [] hors page de recherche. */
	findCards(root: ParentNode, pageUrl: URL): CardRef[];
	/** L'icône de la carte est insérée APRÈS cet élément. */
	cardAnchor(card: Element): Element | null;
	/** Annonce lue sur la carte seule : repli `partial` quand la fiche est illisible. */
	listingFromCard?(card: Element, pageUrl: URL): Listing | null;
}
