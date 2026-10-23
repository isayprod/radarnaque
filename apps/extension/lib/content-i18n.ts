import type { Locale, SearchAspect } from "@radarnaque/shared";
import type { Site } from "./listing/types";

// Textes de l'interface injectée (pastille, panneau, icônes de cartes). Séparés
// du dictionnaire de la popup (lib/i18n.ts) : le content script n'a pas besoin
// du reste. Les règles locales n'ont plus de texte : elles ne sont jamais
// affichées, seulement envoyées avec la demande comme contexte pour l'IA.
export type ContentKey =
	| "level.low"
	| "level.medium"
	| "level.high"
	| "panel.title"
	| "panel.close"
	| "badge.aria"
	| "pro.notice"
	| "card.aria"
	| "card.loading"
	| "card.level.low"
	| "card.level.medium"
	| "card.level.high"
	| "severity.danger"
	| "severity.warning"
	| "severity.info"
	| AiKey
	| IdentifyKey
	| ProgressKey
	| DebugKey;

// Codes d'erreur de la section IA : ceux de l'API (§7.5) et ceux du service worker.
const AI_ERROR_CODES = [
	"session_expired",
	"unauthenticated",
	"no_active_subscription",
	"quota_exhausted",
	"feature_not_in_plan",
	"invalid_listing",
	"rate_limited",
	"analysis_failed",
	"network",
	"background_unavailable",
	"stream_interrupted",
	"timeout",
	"default",
] as const;

type AiErrorKey = `ai.error.${(typeof AI_ERROR_CODES)[number]}`;

// Textes de la section IA du panneau. `ai.remaining` utilise `{count}`.
type AiKey =
	| "ai.title"
	| "ai.analyzeRisk"
	| "ai.launchShort"
	| "ai.retry"
	| "ai.noScansLeft"
	| "ai.noPhoto"
	| "ai.howAnalyzed"
	| "ai.loading"
	| "ai.accessLoading"
	| "ai.login"
	| "ai.loginHint"
	| "ai.loginFallback"
	| "ai.pricing"
	| "ai.fromCache"
	| "ai.partial"
	| "ai.remaining"
	| "ai.advice"
	| "ai.reasons"
	| "ai.product"
	| AiErrorKey;

// États d'identification de la pilule et section Identification du panneau.
// `identify.percent` utilise `{count}` ; `identify.either`, `{a}` et `{b}` (les
// deux premiers candidats) ; `identify.name`, `{name}` (le nom accessible de la
// partie produit de la pilule).
type IdentifyKey =
	| "identify.launch"
	| "identify.launchShort"
	| "identify.title"
	| "identify.product"
	| "identify.detail"
	| "identify.level.sure"
	| "identify.level.probable"
	| "identify.level.uncertain"
	| "identify.percent"
	| "identify.either"
	| "identify.none"
	| "identify.included"
	| "identify.verified"
	| "identify.unsourced"
	| "identify.criteria"
	| "identify.photo"
	| "identify.check.match"
	| "identify.check.contrary"
	| "identify.check.notVisible"
	| "identify.candidates"
	| "identify.askSeller"
	| "identify.notVisibleList"
	| "identify.copy"
	| "identify.copied"
	| "identify.accessories"
	| "identify.object"
	| "identify.pages"
	| "identify.howIdentified"
	| "identify.start"
	| "identify.name";

// Ligne d'état d'une analyse en cours (`statusLine`). `{count}`, `{aspect}`,
// `{query}`, `{results}` et `{domains}` sont remplis par `scan-progress.ts`.
type ProgressKey =
	| "progress.start"
	| "progress.cache"
	| "progress.photos"
	| "progress.photosOne"
	| "progress.analyzing"
	| "progress.analyzingOne"
	| "progress.analyzingNone"
	| "progress.search"
	| `progress.aspect.${SearchAspect}`
	| "progress.results"
	| "progress.resultsOne"
	| "progress.searchDone"
	| "progress.searchFailed"
	| "progress.writing"
	| "progress.readingPhotos"
	| "progress.criteria"
	| "progress.criteriaCached"
	| "progress.pageRead"
	| "progress.identifying"
	| "progress.retrying"
	| "progress.identification"
	| "progress.identificationError";

// Section « Debug (superuser) » du panneau, réservée au superuser de développement.
type DebugKey =
	| "debug.title"
	| "debug.copy"
	| "debug.copied"
	| "debug.rescan"
	| "debug.systemPrompt"
	| "debug.messages"
	| "debug.rawResponse"
	| "debug.searches"
	| "debug.reasoning";

export const CONTENT_TEXTS: Record<Locale, Record<ContentKey, string>> = {
	fr: {
		"level.low": "Risque faible",
		"level.medium": "Risque moyen",
		"level.high": "Risque élevé",
		"panel.title": "Analyse Radarnaque",
		"panel.close": "Fermer",
		"badge.aria": "Ouvrir l'analyse Radarnaque",
		"pro.notice":
			"Annonce d'un professionnel : elle sert souvent de vitrine (prix sur demande, voir le site du vendeur). Ce n'est pas un signal d'arnaque.",
		"card.aria": "Analyser cette annonce avec Radarnaque",
		"card.loading": "Analyse…",
		"card.level.low": "Faible",
		"card.level.medium": "Moyen",
		"card.level.high": "Élevé",
		"severity.danger": "Grave",
		"severity.warning": "Attention",
		"severity.info": "Info",
		"ai.title": "Analyse IA",
		"ai.analyzeRisk": "Analyser le risque",
		"ai.launchShort": "Analyser",
		"ai.retry": "Relancer",
		"ai.noScansLeft": "Plus d'analyses IA disponibles",
		"ai.noPhoto": "Analysée sans photo",
		"ai.howAnalyzed": "Comment l'IA a analysé",
		"ai.loading": "Analyse en cours…",
		"ai.accessLoading": "Chargement…",
		"ai.login": "Se connecter",
		"ai.loginHint": "Connectez-vous pour lancer une analyse IA.",
		"ai.loginFallback":
			"Cliquez sur l'icône Radarnaque dans la barre d'outils du navigateur pour vous connecter.",
		"ai.pricing": "Voir les formules",
		"ai.fromCache": "Résultat déjà disponible : servi depuis le cache.",
		"ai.partial":
			"Analyse partielle : seules les informations de la carte étaient disponibles.",
		"ai.remaining": "Analyses restantes : {count}",
		"ai.advice": "Conseil",
		"ai.reasons": "Pourquoi",
		"ai.error.session_expired": "Session expirée, reconnectez-vous.",
		"ai.error.unauthenticated": "Session expirée, reconnectez-vous.",
		"ai.error.no_active_subscription":
			"Un abonnement est nécessaire pour lancer une analyse IA.",
		"ai.error.quota_exhausted":
			"Vous avez utilisé toutes vos analyses IA pour cette période.",
		"ai.error.feature_not_in_plan":
			"Cette analyse n'est pas comprise dans votre formule.",
		"ai.error.invalid_listing":
			"Cette annonce ne peut pas être analysée (données illisibles).",
		"ai.error.rate_limited":
			"Trop d'analyses en peu de temps. Réessayez dans une minute.",
		"ai.error.analysis_failed":
			"L'analyse a échoué. Elle ne vous a pas été décomptée. Réessayez plus tard.",
		"ai.error.network": "Connexion impossible. Vérifiez votre réseau.",
		"ai.error.background_unavailable":
			"Connexion impossible. Vérifiez votre réseau.",
		"ai.error.stream_interrupted": "Analyse interrompue",
		"ai.error.timeout": "L'analyse a pris trop de temps",
		"ai.error.default": "Une erreur est survenue. Réessayez plus tard.",
		"identify.launch": "Identifier le produit",
		"identify.launchShort": "Identifier",
		"identify.title": "Identification",
		"identify.product": "Produit",
		"identify.detail": "Détail du produit",
		"identify.level.sure": "Sûr",
		"identify.level.probable": "Probable",
		"identify.level.uncertain": "Incertain",
		"identify.percent": "{count} %",
		"identify.either": "{a} ou {b} ?",
		"identify.none": "Produit non identifié",
		"identify.included": "Inclus avec l'identification",
		"identify.verified": "Critères vérifiés par Radarnaque",
		"identify.unsourced": "Critères non confirmés par une source",
		"identify.criteria": "Critères",
		"identify.photo": "photo {n}",
		"identify.check.match": "Vu",
		"identify.check.contrary": "Contraire",
		"identify.check.notVisible": "Non visible",
		"identify.candidates": "Candidats restants",
		"identify.askSeller": "À demander au vendeur",
		"identify.notVisibleList": "Non visible sur les photos : {list}",
		"identify.copy": "Copier",
		"identify.copied": "Copié",
		"identify.accessories": "Accessoires",
		"identify.object": "Objet",
		"identify.pages": "Pages de référence",
		"identify.howIdentified": "Déroulé de l'identification",
		"identify.start": "Démarrage de l'identification…",
		"identify.name": "Identification : {name}",
		"ai.product": "Produit : {reference} ({level})",
		"progress.start": "Démarrage de l'analyse",
		"progress.cache": "Analyse déjà disponible",
		"progress.photos": "Téléchargement de {count} photos",
		"progress.photosOne": "Téléchargement d'1 photo",
		"progress.analyzing": "Examine l'annonce et {count} photos",
		"progress.analyzingOne": "Examine l'annonce et 1 photo",
		"progress.analyzingNone": "Examine l'annonce sans photo",
		"progress.search": "Recherche web ({aspect}) : “{query}”",
		"progress.aspect.model": "modèle",
		"progress.aspect.price": "prix du marché",
		"progress.aspect.scam": "arnaque connue",
		"progress.aspect.other": "autre",
		"progress.results": "{count} résultats",
		"progress.resultsOne": "{count} résultat",
		"progress.searchDone": "{results} : {domains}",
		"progress.searchFailed": "Recherche indisponible, l'analyse continue",
		"progress.writing": "Rédige le verdict",
		"progress.readingPhotos": "Lecture des photos…",
		"progress.criteria": "Recherche des critères…",
		"progress.criteriaCached": "Critères connus de Radarnaque",
		"progress.pageRead": "Lecture : {domain}",
		"progress.identifying": "Vérification des critères…",
		"progress.retrying": "Vérification complémentaire…",
		"progress.identification": "Produit identifié",
		"progress.identificationError": "Identification impossible",
		"debug.title": "Debug (superuser)",
		"debug.copy": "Copier",
		"debug.copied": "Copié",
		"debug.rescan": "Relancer sans cache",
		"debug.systemPrompt": "Prompt système",
		"debug.messages": "Messages envoyés",
		"debug.rawResponse": "Réponse brute",
		"debug.searches": "Recherches web",
		"debug.reasoning": "Réflexion",
	},
	nl: {
		"level.low": "Laag risico",
		"level.medium": "Gemiddeld risico",
		"level.high": "Hoog risico",
		"panel.title": "Radarnaque-analyse",
		"panel.close": "Sluiten",
		"badge.aria": "Radarnaque-analyse openen",
		"pro.notice":
			"Advertentie van een professional: ze dient vaak als etalage (prijs op aanvraag, zie de website van de verkoper). Dat is geen teken van oplichting.",
		"card.aria": "Deze advertentie analyseren met Radarnaque",
		"card.loading": "Analyseren…",
		"card.level.low": "Laag",
		"card.level.medium": "Gemiddeld",
		"card.level.high": "Hoog",
		"severity.danger": "Ernstig",
		"severity.warning": "Let op",
		"severity.info": "Info",
		"ai.title": "AI-analyse",
		"ai.analyzeRisk": "Risico analyseren",
		"ai.launchShort": "Analyseren",
		"ai.retry": "Opnieuw proberen",
		"ai.noScansLeft": "Geen AI-analyses meer beschikbaar",
		"ai.noPhoto": "Geanalyseerd zonder foto",
		"ai.howAnalyzed": "Hoe de AI analyseerde",
		"ai.loading": "Analyse bezig…",
		"ai.accessLoading": "Laden…",
		"ai.login": "Aanmelden",
		"ai.loginHint": "Meld je aan om een AI-analyse te starten.",
		"ai.loginFallback":
			"Klik op het Radarnaque-icoon in de werkbalk van je browser om je aan te melden.",
		"ai.pricing": "Formules bekijken",
		"ai.fromCache": "Resultaat al beschikbaar: geladen uit de cache.",
		"ai.partial":
			"Gedeeltelijke analyse: alleen de gegevens van de kaart waren beschikbaar.",
		"ai.remaining": "Resterende analyses: {count}",
		"ai.advice": "Advies",
		"ai.reasons": "Waarom",
		"ai.error.session_expired": "Sessie verlopen, meld je opnieuw aan.",
		"ai.error.unauthenticated": "Sessie verlopen, meld je opnieuw aan.",
		"ai.error.no_active_subscription":
			"Je hebt een abonnement nodig om een AI-analyse te starten.",
		"ai.error.quota_exhausted":
			"Je hebt al je AI-analyses voor deze periode gebruikt.",
		"ai.error.feature_not_in_plan": "Deze analyse zit niet in je formule.",
		"ai.error.invalid_listing":
			"Deze advertentie kan niet geanalyseerd worden (onleesbare gegevens).",
		"ai.error.rate_limited":
			"Te veel analyses in korte tijd. Probeer het over een minuut opnieuw.",
		"ai.error.analysis_failed":
			"De analyse is mislukt. Ze werd niet aangerekend. Probeer het later opnieuw.",
		"ai.error.network": "Geen verbinding mogelijk. Controleer je netwerk.",
		"ai.error.background_unavailable":
			"Geen verbinding mogelijk. Controleer je netwerk.",
		"ai.error.stream_interrupted": "Analyse onderbroken",
		"ai.error.timeout": "De analyse duurde te lang",
		"ai.error.default": "Er is een fout opgetreden. Probeer het later opnieuw.",
		"identify.launch": "Product identificeren",
		"identify.launchShort": "Identificeren",
		"identify.title": "Identificatie",
		"identify.product": "Product",
		"identify.detail": "Productdetails",
		"identify.level.sure": "Zeker",
		"identify.level.probable": "Waarschijnlijk",
		"identify.level.uncertain": "Onzeker",
		"identify.percent": "{count}%",
		"identify.either": "{a} of {b}?",
		"identify.none": "Product niet geïdentificeerd",
		"identify.included": "Inbegrepen bij de identificatie",
		"identify.verified": "Criteria gecontroleerd door Radarnaque",
		"identify.unsourced": "Criteria niet bevestigd door een bron",
		"identify.criteria": "Criteria",
		"identify.photo": "foto {n}",
		"identify.check.match": "Gezien",
		"identify.check.contrary": "Tegenstrijdig",
		"identify.check.notVisible": "Niet zichtbaar",
		"identify.candidates": "Overige kandidaten",
		"identify.askSeller": "Te vragen aan de verkoper",
		"identify.notVisibleList": "Niet zichtbaar op de foto's: {list}",
		"identify.copy": "Kopiëren",
		"identify.copied": "Gekopieerd",
		"identify.accessories": "Accessoires",
		"identify.object": "Object",
		"identify.pages": "Referentiepagina's",
		"identify.howIdentified": "Verloop van de identificatie",
		"identify.start": "Identificatie starten…",
		"identify.name": "Identificatie: {name}",
		"ai.product": "Product: {reference} ({level})",
		"progress.start": "Analyse wordt gestart",
		"progress.cache": "Analyse al beschikbaar",
		"progress.photos": "{count} foto's downloaden",
		"progress.photosOne": "1 foto downloaden",
		"progress.analyzing": "Bekijkt de advertentie en {count} foto's",
		"progress.analyzingOne": "Bekijkt de advertentie en 1 foto",
		"progress.analyzingNone": "Bekijkt de advertentie zonder foto",
		"progress.search": "Webzoekopdracht ({aspect}): “{query}”",
		"progress.aspect.model": "model",
		"progress.aspect.price": "marktprijs",
		"progress.aspect.scam": "bekende oplichting",
		"progress.aspect.other": "overig",
		"progress.results": "{count} resultaten",
		"progress.resultsOne": "{count} resultaat",
		"progress.searchDone": "{results}: {domains}",
		"progress.searchFailed":
			"Zoekopdracht niet beschikbaar, de analyse gaat door",
		"progress.writing": "Schrijft het oordeel",
		"progress.readingPhotos": "Foto's lezen…",
		"progress.criteria": "Criteria zoeken…",
		"progress.criteriaCached": "Criteria al bekend bij Radarnaque",
		"progress.pageRead": "Lezen: {domain}",
		"progress.identifying": "Criteria controleren…",
		"progress.retrying": "Extra controle…",
		"progress.identification": "Product geïdentificeerd",
		"progress.identificationError": "Identificatie mislukt",
		"debug.title": "Debug (superuser)",
		"debug.copy": "Kopiëren",
		"debug.copied": "Gekopieerd",
		"debug.rescan": "Opnieuw zonder cache",
		"debug.systemPrompt": "Systeemprompt",
		"debug.messages": "Verzonden berichten",
		"debug.rawResponse": "Ruw antwoord",
		"debug.searches": "Webzoekopdrachten",
		"debug.reasoning": "Redenering",
	},
};

export function contentText(locale: Locale, key: ContentKey): string {
	return CONTENT_TEXTS[locale][key];
}

/**
 * Texte d'un code d'erreur de la section IA. Tout code inconnu donne
 * `ai.error.default` : on s'appuie sur le code, jamais sur le message de l'API.
 */
export function aiErrorText(locale: Locale, code: string): string {
	const known = (AI_ERROR_CODES as readonly string[]).includes(code);
	return contentText(
		locale,
		known ? (`ai.error.${code}` as AiErrorKey) : "ai.error.default",
	);
}

export function resolveContentLocale(
	site: Site,
	pref: Locale | null,
	uiLanguage: string,
): Locale {
	if (pref) return pref;
	if (site === "2dehands.be") return "nl";
	if (site === "2ememain.be") return "fr";
	return uiLanguage.toLowerCase().startsWith("nl") ? "nl" : "fr";
}
