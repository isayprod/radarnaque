export type Site = "2ememain.be" | "2dehands.be" | "facebook.com";
export type PageType = "listing" | "search" | "other";

export interface Listing {
	site: Site;
	externalId: string;
	url: string;
	title: string;
	description: string;
	price: { amountCents: number; currency: "EUR" } | null;
	priceType: "fixed" | "bidding" | "free" | "unknown";
	category?: string;
	condition?: string;
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
	};
}
