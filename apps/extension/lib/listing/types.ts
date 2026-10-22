export type Site = "2ememain.be" | "2dehands.be" | "facebook.com";
export type PageType = "listing" | "search" | "other";

export interface Listing {
	site: Site;
	externalId: string;
	url: string;
	title: string;
	description: string;
	price: { amountCents: number; currency: "EUR" } | null;
	/**
	 * Même ensemble que l'API. `on_request`, `see_description`, `exchange` et
	 * `reserved` n'ont jamais de montant fiable : aucune règle de prix ne s'y applique.
	 */
	priceType:
		| "fixed"
		| "bidding"
		| "free"
		| "on_request"
		| "see_description"
		| "exchange"
		| "reserved"
		| "unknown";
	category?: string;
	condition?: string;
	/**
	 * Caractéristiques affichées par le site (année, kilométrage, capacité…), dans
	 * l'ordre, libellés dans la langue de la page.
	 */
	attributes?: { label: string; value: string }[];
	/** ISO 8601 */
	postedAt?: string;
	location: { city?: string; region?: string; country?: string };
	/** URLs absolues, dans l'ordre d'affichage */
	images: string[];
	seller: {
		/** id, name et profileUrl ne quittent jamais le navigateur */
		id?: string;
		name?: string;
		profileUrl?: string;
		/** Ancienneté du compte en mois : fourchette, car les sites donnent une durée ou une année. */
		accountAgeMonths?: { min: number; max: number };
		reviewCount?: number;
		rating?: number;
		otherListingsCount?: number;
		verified?: boolean;
		/** Particulier ou professionnel : un fait sur le vendeur, pas son identité. */
		sellerKind?: "private" | "professional";
	};
}
