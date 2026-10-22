/**
 * Textes de la landing (spec landing §3) : FR mot pour mot, NL de Flandre au
 * tutoiement (« je »), même structure. Les textes de la navigation et du pied de
 * page sont dans `LAYOUT_TEXT` (layout.ts), ceux des formules dans `PRICING`.
 *
 * Aucun import à l'exécution : `scripts/og.ts` lit ce fichier directement avec Node.
 */
import type { Locale } from "@radarnaque/shared";

export interface LandingStep {
	title: string;
	body: string;
}

export interface LandingText {
	/** `<title>` : 65 caractères au plus. */
	title: string;
	/** Meta description (160 caractères au plus), reprise par Open Graph et Twitter Card. */
	description: string;
	/** Hero. */
	heroTitle: string;
	heroTagline: string;
	heroNote: string;
	/** Pilule d'installation, et son texte quand le lien du store manque. */
	install: string;
	installSoon: string;
	/** Bénéfices : quatre éléments sur une ligne. */
	benefits: readonly [string, string, string, string];
	/** « Comment ça marche » : étiquette, titre, trois étapes et leurs pilules. */
	howLabel: string;
	howTitle: string;
	steps: readonly [LandingStep, LandingStep, LandingStep];
	stepAnalyze: string;
	stepLevel: string;
	stepScore: string;
	/** Formules : étiquette, titre, phrase, badge de l'essai, période, note, lien. */
	plansLabel: string;
	plansTitle: string;
	plansLead: string;
	freeBadge: string;
	perMonth: string;
	paymentSoon: string;
	plansDetail: string;
	/** Installation : titre et ligne des liens. */
	installTitle: string;
	browsers: string;
	privacyPolicy: string;
	sourceCode: string;
}

export const LANDING_TEXT: Record<Locale, LandingText> = {
	fr: {
		title: "Radarnaque – repérez l'arnaque avant de payer",
		description:
			"Extension pour Chrome qui lit les annonces de 2ememain, 2dehands et Facebook Marketplace, texte et photos, et vous dit si quelque chose cloche. Essai gratuit.",
		heroTitle: "Repérez l'arnaque avant de payer.",
		heroTagline:
			"Radarnaque lit l'annonce et ses photos sur 2ememain, 2dehands et Facebook Marketplace, et vous dit en quelques secondes si quelque chose cloche.",
		heroNote: "Extension pour Chrome · essai gratuit, sans carte bancaire",
		install: "Ajouter à Chrome, c'est gratuit",
		installSoon: "Bientôt disponible",
		benefits: [
			"Analyse du texte et des photos",
			"Comparaison avec le prix du marché",
			"Verdict en quelques secondes",
			"En français et en néerlandais",
		],
		howLabel: "Comment ça marche",
		howTitle: "Trois gestes, avant d'envoyer le moindre euro.",
		steps: [
			{
				title: "Ouvrez une annonce",
				body: "Sur 2ememain, 2dehands ou Facebook Marketplace. Radarnaque ajoute un bouton à côté du titre.",
			},
			{
				title: "Cliquez sur Analyser",
				body: "L'IA lit la description, les photos et le profil du vendeur, et cherche le prix du modèle ailleurs.",
			},
			{
				title: "Lisez le verdict",
				body: "Un niveau de risque, les raisons et un conseil concret : continuer, poser des questions, ou passer son chemin.",
			},
		],
		stepAnalyze: "Analyser",
		stepLevel: "Risque faible",
		stepScore: "12/100",
		plansLabel: "Formules",
		plansTitle: "Commencez gratuitement.",
		plansLead:
			"L'essai ne demande qu'une adresse email. Passez à une formule quand vous en avez besoin.",
		freeBadge: "Gratuit",
		perMonth: "/ mois",
		paymentSoon: "Paiement bientôt disponible.",
		plansDetail: "Détail des formules",
		installTitle: "Le bon réflexe avant chaque achat d'occasion.",
		browsers: "Chrome, Edge, Brave et autres navigateurs Chromium",
		privacyPolicy: "Politique de confidentialité",
		sourceCode: "Code source",
	},
	nl: {
		title: "Radarnaque – herken oplichting voor je betaalt",
		description:
			"Extensie voor Chrome die advertenties op 2dehands, 2ememain en Facebook Marketplace leest, tekst en foto's, en je zegt of er iets niet klopt. Gratis proef.",
		heroTitle: "Herken oplichting voor je betaalt.",
		heroTagline:
			"Radarnaque leest de advertentie en de foto's op 2dehands, 2ememain en Facebook Marketplace, en zegt je binnen enkele seconden of er iets niet klopt.",
		heroNote: "Extensie voor Chrome · gratis proef, zonder bankkaart",
		install: "Toevoegen aan Chrome, het is gratis",
		installSoon: "Binnenkort beschikbaar",
		benefits: [
			"Analyse van tekst en foto's",
			"Vergelijking met de marktprijs",
			"Oordeel binnen enkele seconden",
			"In het Nederlands en het Frans",
		],
		howLabel: "Hoe het werkt",
		howTitle: "Drie stappen, voor je ook maar één euro verstuurt.",
		steps: [
			{
				title: "Open een advertentie",
				body: "Op 2dehands, 2ememain of Facebook Marketplace. Radarnaque zet een knop naast de titel.",
			},
			{
				title: "Klik op Analyseren",
				body: "De AI leest de beschrijving, de foto's en het profiel van de verkoper, en zoekt elders naar de prijs van het model.",
			},
			{
				title: "Lees het oordeel",
				body: "Een risiconiveau, de redenen en concreet advies: doorgaan, vragen stellen of het laten liggen.",
			},
		],
		stepAnalyze: "Analyseren",
		stepLevel: "Laag risico",
		stepScore: "12/100",
		plansLabel: "Formules",
		plansTitle: "Begin gratis.",
		plansLead:
			"Voor de proef heb je alleen een e-mailadres nodig. Kies een formule wanneer je die nodig hebt.",
		freeBadge: "Gratis",
		perMonth: "/ maand",
		paymentSoon: "Betalen binnenkort beschikbaar.",
		plansDetail: "Details van de formules",
		installTitle: "De juiste reflex voor elke tweedehandsaankoop.",
		browsers: "Chrome, Edge, Brave en andere Chromium-browsers",
		privacyPolicy: "Privacybeleid",
		sourceCode: "Broncode",
	},
};
