import type { Locale } from "@radarnaque/shared";

/** Single source of truth for prices (cents, VAT included) and quotas (spec 2.2). */
export const PLANS = {
	trial: { scans: 3 },
	standard: {
		monthlyCents: 299,
		yearlyCents: 2900,
		textPerMonth: 150,
		photoPerMonth: 0,
	},
	premium: {
		monthlyCents: 699,
		yearlyCents: 6900,
		textPerMonth: 1000,
		photoPerMonth: 100,
	},
} as const;

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
	/** Placeholders: {scans} {texts} {photos}. */
	features: Record<string, string>;
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
	privacyLink: string;
	switchLang: string;
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
		privacyLink: "Politique de confidentialité",
		switchLang: "Nederlands",
		plans: {
			trial: {
				name: "Essai",
				tagline: "Pour découvrir",
				features: {
					scans: "{scans} analyses offertes au total, une fois pour toutes",
					all: "Toutes les fonctionnalités",
				},
			},
			standard: {
				name: "Standard",
				tagline: "Pour un usage régulier",
				features: {
					texts: "{texts} analyses de texte par mois",
					photos: "Pas d'analyse de photos",
					button: "Bouton d'analyse IA sur la page de l'annonce",
				},
			},
			premium: {
				name: "Premium",
				tagline: "Pour un usage intensif",
				features: {
					button: "Bouton d'analyse IA sur la page de l'annonce",
					texts: "{texts} analyses de texte par mois",
					photos: "{photos} analyses avec photos par mois",
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
		privacyLink: "Privacybeleid",
		switchLang: "Français",
		plans: {
			trial: {
				name: "Proef",
				tagline: "Om kennis te maken",
				features: {
					scans: "{scans} gratis analyses in totaal, eenmalig",
					all: "Alle functies",
				},
			},
			standard: {
				name: "Standard",
				tagline: "Voor regelmatig gebruik",
				features: {
					texts: "{texts} tekstanalyses per maand",
					photos: "Geen foto-analyses",
					button: "AI-analyseknop op de pagina van de advertentie",
				},
			},
			premium: {
				name: "Premium",
				tagline: "Voor intensief gebruik",
				features: {
					button: "AI-analyseknop op de pagina van de advertentie",
					texts: "{texts} tekstanalyses per maand",
					photos: "{photos} analyses met foto's per maand",
					icons: "Iconen op de zoekresultaten",
				},
			},
		},
	},
};

export interface PrivacySection {
	heading: string;
	/** May contain {email} and {months}. */
	body: string;
}

export interface PrivacyText {
	title: string;
	intro: string;
	backToPricing: string;
	switchLang: string;
	sections: {
		hosting: PrivacySection;
		trigger: PrivacySection;
		photos: PrivacySection;
		web: PrivacySection;
		browser: PrivacySection;
		seller: PrivacySection;
		ai: PrivacySection;
		kept: PrivacySection;
		listings: PrivacySection;
		erasure: PrivacySection;
		local: PrivacySection;
	};
}

export const PRIVACY_RETENTION_MONTHS = 12;

/** Display order of the privacy sections. */
export const PRIVACY_ORDER = [
	"local",
	"trigger",
	"seller",
	"photos",
	"web",
	"browser",
	"ai",
	"hosting",
	"kept",
	"listings",
	"erasure",
] as const satisfies readonly (keyof PrivacyText["sections"])[];

export const PRIVACY: Record<Locale, PrivacyText> = {
	fr: {
		title: "Politique de confidentialité",
		intro:
			"Voici, en clair, ce que Radarnaque fait et ne fait pas avec vos données.",
		backToPricing: "Tarifs",
		switchLang: "Nederlands",
		sections: {
			local: {
				heading: "Sans compte : tout reste dans votre navigateur",
				body: "Sans compte, les règles locales de Radarnaque s'exécutent entièrement dans votre navigateur. Rien n'est envoyé à notre serveur.",
			},
			trigger: {
				heading: "Quand une analyse est lancée",
				body: "Une analyse IA n'est faite que lorsque vous la demandez, par un clic (bouton sur l'annonce, ou icône sur les résultats de recherche avec Premium).",
			},
			seller: {
				heading: "L'identité du vendeur n'est jamais envoyée",
				body: "Avec un compte, le contenu de l'annonce est envoyé pour analyse. Le nom et l'identifiant du vendeur, ainsi que le lien vers son profil, ne sont jamais envoyés, ni à notre serveur ni à l'IA. Seuls des éléments qui ne permettent pas de l'identifier sont envoyés : ancienneté du compte, nombre d'avis, note, autres annonces, vérification. Les numéros de téléphone et les adresses email présents dans l'annonce sont masqués avant l'envoi à l'IA.",
			},
			photos: {
				heading: "Les photos de l'annonce",
				body: "Une analyse IA envoie les photos de l'annonce : 1 photo en Standard, jusqu'à 4 en Premium et pendant l'essai. Elles sont téléchargées par notre serveur, puis envoyées à l'IA.",
			},
			web: {
				heading: "Recherches sur le web",
				body: "Pendant une analyse, l'IA peut faire jusqu'à 3 recherches sur le web, sur l'objet de l'annonce (son modèle, son prix sur le marché). Les requêtes ne contiennent ni l'identité du vendeur ni vos données, et les numéros de téléphone et les adresses email en sont masqués. Elles partent de notre serveur vers des moteurs de recherche, par notre propre service de recherche.",
			},
			browser: {
				heading: "Ce qui est gardé dans votre navigateur",
				body: "Le résultat d'une analyse est gardé 24 h dans votre navigateur, pour le réafficher sans refaire l'analyse. Il est effacé à votre déconnexion et à la suppression de votre compte.",
			},
			ai: {
				heading: "Données envoyées à l'IA",
				body: "Nous demandons au fournisseur d'IA de ne pas collecter ni réutiliser les données envoyées.",
			},
			hosting: {
				heading: "Où sont traitées les données",
				body: "Notre serveur est situé en Allemagne (Union européenne). Le fournisseur d'IA peut toutefois traiter les données hors de l'UE. Les sauvegardes chiffrées de notre base sont aussi copiées vers un stockage externe. Votre adresse email est transmise à notre prestataire d'envoi d'emails (Resend) pour vous envoyer le lien et le code de connexion ; ce prestataire peut la traiter hors de l'UE.",
			},
			kept: {
				heading: "Les données que nous conservons sur vous",
				body: "Nous conservons votre adresse email, votre abonnement et l'historique de vos analyses. Cet historique est supprimé après {months} mois. Pour l'essai, nous gardons seulement le nombre d'analyses déjà utilisées, sans leur contenu.",
			},
			listings: {
				heading: "Les analyses d'annonces",
				body: "Les analyses d'annonces et leurs instantanés ne sont pas des données personnelles : ils sont conservés.",
			},
			erasure: {
				heading: "Droit à l'effacement",
				body: "Dans la popup de l'extension, « Supprimer mon compte » supprime votre utilisateur, vos abonnements et l'historique de vos analyses, tout de suite. Les copies de sauvegarde chiffrées qui contiennent encore ces données sont effacées au fil de leur renouvellement (14 jours sur notre serveur). Pour toute autre demande, écrivez-nous à {email}.",
			},
		},
	},
	nl: {
		title: "Privacybeleid",
		intro:
			"Hier leest u in gewone taal wat Radarnaque wel en niet doet met uw gegevens.",
		backToPricing: "Tarieven",
		switchLang: "Français",
		sections: {
			local: {
				heading: "Zonder account blijft alles in uw browser",
				body: "Zonder account worden de lokale regels van Radarnaque volledig in uw browser uitgevoerd. Er wordt niets naar onze server gestuurd.",
			},
			trigger: {
				heading: "Wanneer een analyse wordt gestart",
				body: "Een AI-analyse gebeurt alleen wanneer u erom vraagt, met een klik (knop op de advertentie, of icoon op de zoekresultaten met Premium).",
			},
			seller: {
				heading: "De identiteit van de verkoper wordt nooit verstuurd",
				body: "Met een account wordt de inhoud van de advertentie voor analyse verstuurd. De naam en de identificatie van de verkoper, en de link naar zijn profiel, worden nooit verstuurd, noch naar onze server, noch naar de AI. Alleen gegevens die de verkoper niet identificeren, worden verstuurd: hoe lang het account al bestaat, aantal beoordelingen, score, andere advertenties, verificatie. Telefoonnummers en e-mailadressen in de advertentie worden gemaskeerd voordat ze naar de AI worden verstuurd.",
			},
			photos: {
				heading: "De foto's van de advertentie",
				body: "Een AI-analyse stuurt de foto's van de advertentie mee: 1 foto bij Standard, maximaal 4 bij Premium en tijdens de proef. Ze worden door onze server gedownload en daarna naar de AI verstuurd.",
			},
			web: {
				heading: "Zoekopdrachten op het web",
				body: "Tijdens een analyse kan de AI tot 3 zoekopdrachten op het web doen, over het voorwerp van de advertentie (het model, de marktprijs). De zoekopdrachten bevatten noch de identiteit van de verkoper, noch uw gegevens, en telefoonnummers en e-mailadressen worden erin gemaskeerd. Ze vertrekken van onze server naar zoekmachines, via onze eigen zoekdienst.",
			},
			browser: {
				heading: "Wat in uw browser bewaard blijft",
				body: "Het resultaat van een analyse wordt 24 uur in uw browser bewaard, om het opnieuw te tonen zonder de analyse te herhalen. Het wordt gewist wanneer u zich afmeldt en wanneer u uw account verwijdert.",
			},
			ai: {
				heading: "Gegevens die naar de AI worden verstuurd",
				body: "Wij vragen de AI-aanbieder om de verstuurde gegevens niet te verzamelen en niet opnieuw te gebruiken.",
			},
			hosting: {
				heading: "Waar de gegevens worden verwerkt",
				body: "Onze server staat in Duitsland (Europese Unie). De AI-aanbieder kan de gegevens wel buiten de EU verwerken. De versleutelde back-ups van onze database worden ook naar een externe opslag gekopieerd. Uw e-mailadres wordt doorgegeven aan onze aanbieder voor het verzenden van e-mails (Resend), om u de link en de inlogcode te sturen; die aanbieder kan het adres buiten de EU verwerken.",
			},
			kept: {
				heading: "De gegevens die wij over u bewaren",
				body: "Wij bewaren uw e-mailadres, uw abonnement en de geschiedenis van uw analyses. Die geschiedenis wordt na {months} maanden gewist. Voor de proef bewaren wij alleen het aantal reeds gebruikte analyses, zonder de inhoud.",
			},
			listings: {
				heading: "Analyses van advertenties",
				body: "Analyses van advertenties en hun momentopnames zijn geen persoonsgegevens en worden bewaard.",
			},
			erasure: {
				heading: "Recht op gegevenswissing",
				body: "Met „Mijn account verwijderen” in de popup van de extensie worden uw gebruikersgegevens, uw abonnementen en de geschiedenis van uw analyses gewist, meteen. De versleutelde back-ups die deze gegevens nog bevatten, worden gewist naarmate ze worden vernieuwd (14 dagen op onze server). Voor elke andere vraag kunt u mailen naar {email}.",
			},
		},
	},
};
