import type { Locale } from "@radarnaque/shared";
import type { Offer } from "./offer.ts";

/** Offre de secours (centimes, TVA comprise) : affichée tant que `GET /api/offer` n'a pas répondu, ou s'il échoue. */
export const PLANS: Offer = {
	trial: {
		scans: 3,
		maxImages: 4,
		cardIcons: true,
		monthlyCents: null,
		yearlyCents: null,
	},
	standard: {
		scans: 150,
		maxImages: 1,
		cardIcons: false,
		monthlyCents: 299,
		yearlyCents: 2900,
	},
	premium: {
		scans: 300,
		maxImages: 4,
		cardIcons: true,
		monthlyCents: 699,
		yearlyCents: 6900,
	},
};

// To be confirmed by the owner before going live.
export const PRIVACY_EMAIL = "privacy@mostconsult.be";

const INTL_LOCALE: Record<Locale, string> = { fr: "fr-BE", nl: "nl-BE" };

export function formatCents(cents: number, locale: Locale): string {
	const whole = cents % 100 === 0;
	return new Intl.NumberFormat(INTL_LOCALE[locale], {
		style: "currency",
		currency: "EUR",
		minimumFractionDigits: whole ? 0 : 2,
		maximumFractionDigits: whole ? 0 : 2,
	}).format(cents / 100);
}

export function formatInt(n: number, locale: Locale): string {
	// nl-BE does not group 4-digit numbers by default; spec shows 1 000 / 1.000.
	return new Intl.NumberFormat(INTL_LOCALE[locale], {
		useGrouping: "always",
	}).format(n);
}

/** Replaces `{name}` placeholders. */
export function fill(
	template: string,
	vars: Record<string, string | number>,
): string {
	return template.replace(/\{(\w+)\}/g, (m, k: string) =>
		k in vars ? String(vars[k]) : m,
	);
}

export interface PlanText {
	name: string;
	tagline: string;
	/** Placeholders: {scans} {photos}. `scansTotal` pour l'essai, `scansMonth` pour les plans payants. */
	features: {
		scansTotal?: string;
		scansMonth?: string;
		photosNone: string;
		photosOne: string;
		photosMany: string;
		button: string;
		icons: string;
	};
}

export interface PricingText {
	title: string;
	intro: string;
	/** Placeholders: {price}. */
	perMonth: string;
	perYear: string;
	vatIncluded: string;
	free: string;
	paymentSoon: string;
	plans: { trial: PlanText; standard: PlanText; premium: PlanText };
}

export const PRICING: Record<Locale, PricingText> = {
	fr: {
		title: "Tarifs",
		intro:
			"Testez Radarnaque gratuitement, puis choisissez la formule qui vous convient.",
		perMonth: "{price} par mois",
		perYear: "ou {price} par an",
		vatIncluded: "TVA comprise",
		free: "Gratuit",
		paymentSoon: "Paiement bientôt disponible",
		plans: {
			trial: {
				name: "Essai",
				tagline: "Pour découvrir",
				features: {
					scansTotal: "{scans} analyses offertes au total",
					photosNone: "Pas de photo analysée",
					photosOne: "1 photo analysée par annonce",
					photosMany: "Jusqu'à {photos} photos analysées par annonce",
					button: "Bouton d'analyse IA sur la page de l'annonce",
					icons: "Icônes sur les résultats de recherche",
				},
			},
			standard: {
				name: "Standard",
				tagline: "Pour un usage régulier",
				features: {
					scansMonth: "{scans} analyses par mois",
					photosNone: "Pas de photo analysée",
					photosOne: "1 photo analysée par annonce",
					photosMany: "Jusqu'à {photos} photos analysées par annonce",
					button: "Bouton d'analyse IA sur la page de l'annonce",
					icons: "Icônes sur les résultats de recherche",
				},
			},
			premium: {
				name: "Premium",
				tagline: "Pour un usage intensif",
				features: {
					scansMonth: "{scans} analyses par mois",
					photosNone: "Pas de photo analysée",
					photosOne: "1 photo analysée par annonce",
					photosMany: "Jusqu'à {photos} photos analysées par annonce",
					button: "Bouton d'analyse IA sur la page de l'annonce",
					icons: "Icônes sur les résultats de recherche",
				},
			},
		},
	},
	nl: {
		title: "Tarieven",
		intro:
			"Probeer Radarnaque gratis en kies daarna de formule die bij u past.",
		perMonth: "{price} per maand",
		perYear: "of {price} per jaar",
		vatIncluded: "btw inbegrepen",
		free: "Gratis",
		paymentSoon: "Betalen binnenkort beschikbaar",
		plans: {
			trial: {
				name: "Proef",
				tagline: "Om kennis te maken",
				features: {
					scansTotal: "{scans} gratis analyses in totaal",
					photosNone: "Geen foto's geanalyseerd",
					photosOne: "1 foto geanalyseerd per advertentie",
					photosMany: "Tot {photos} foto's geanalyseerd per advertentie",
					button: "AI-analyseknop op de pagina van de advertentie",
					icons: "Iconen op de zoekresultaten",
				},
			},
			standard: {
				name: "Standard",
				tagline: "Voor regelmatig gebruik",
				features: {
					scansMonth: "{scans} analyses per maand",
					photosNone: "Geen foto's geanalyseerd",
					photosOne: "1 foto geanalyseerd per advertentie",
					photosMany: "Tot {photos} foto's geanalyseerd per advertentie",
					button: "AI-analyseknop op de pagina van de advertentie",
					icons: "Iconen op de zoekresultaten",
				},
			},
			premium: {
				name: "Premium",
				tagline: "Voor intensief gebruik",
				features: {
					scansMonth: "{scans} analyses per maand",
					photosNone: "Geen foto's geanalyseerd",
					photosOne: "1 foto geanalyseerd per advertentie",
					photosMany: "Tot {photos} foto's geanalyseerd per advertentie",
					button: "AI-analyseknop op de pagina van de advertentie",
					icons: "Iconen op de zoekresultaten",
				},
			},
		},
	},
};

export const PRIVACY_RETENTION_MONTHS = 12;
