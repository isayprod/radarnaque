import type { Listing, PageType, Site } from "../listing/types";

export interface ExtractResult {
	listing: Listing;
	/** Champs non trouvés, pour le debug. */
	missing: string[];
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
}
