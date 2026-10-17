import type { Locale } from "@radarnaque/shared";
import type { Site } from "./listing/types";
import type { RuleId, Signal } from "./rules/rules";

// Textes de l'interface injectée (pastille, panneau) et des signaux de règles.
// Séparés du dictionnaire de la popup (lib/i18n.ts) : le content script n'a pas
// besoin du reste. Les signaux utilisent `{count}` / `{country}`.
type TextKey =
	| "level.low"
	| "level.medium"
	| "level.high"
	| "panel.title"
	| "panel.none"
	| "panel.footer"
	| "badge.aria"
	| "severity.danger"
	| "severity.warning"
	| "severity.info"
	| AiKey
	| Exclude<RuleId, "price_anomaly">;

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
	"default",
] as const;

type AiErrorKey = `ai.error.${(typeof AI_ERROR_CODES)[number]}`;

// Textes de la section IA du panneau. `ai.remaining` utilise `{count}`.
type AiKey =
	| "ai.title"
	| "ai.run"
	| "ai.runPhotos"
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
	| AiErrorKey;

export type ContentKey = Exclude<TextKey, RuleId>;

export const CONTENT_TEXTS: Record<Locale, Record<TextKey, string>> = {
	fr: {
		"level.low": "Risque faible",
		"level.medium": "Risque moyen",
		"level.high": "Risque élevé",
		"panel.title": "Analyse Radarnaque",
		"panel.none": "Aucun signal d'alerte détecté.",
		"panel.footer":
			"Analyse locale, sans IA. Pour une analyse IA, utilisez le bouton ci-dessus.",
		"badge.aria": "Ouvrir l'analyse Radarnaque",
		"severity.danger": "Grave",
		"severity.warning": "Attention",
		"severity.info": "Info",
		few_photos: "Peu de photos ({count})",
		new_account: "Compte vendeur très récent",
		no_reviews: "Aucun avis sur le vendeur",
		foreign_location: "Vendeur situé hors de Belgique ({country})",
		short_description: "Description très courte",
		contact_outside:
			"Invite à continuer hors de la plateforme (téléphone, email ou messagerie)",
		shipping_only: "Envoi uniquement, sans remise en main propre",
		offsite_payment:
			"Mode de paiement à risque (paiement à l'avance ou hors plateforme)",
		symbolic_price: "Prix symbolique, anormalement bas",
		"ai.title": "Analyse IA",
		"ai.run": "Lancer une analyse IA",
		"ai.runPhotos": "Analyse avec photos",
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
			"Vous avez utilisé toutes vos analyses de ce type pour cette période.",
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
		"ai.error.default": "Une erreur est survenue. Réessayez plus tard.",
	},
	nl: {
		"level.low": "Laag risico",
		"level.medium": "Gemiddeld risico",
		"level.high": "Hoog risico",
		"panel.title": "Radarnaque-analyse",
		"panel.none": "Geen waarschuwingssignalen gevonden.",
		"panel.footer":
			"Lokale analyse, zonder AI. Gebruik de knop hierboven voor een AI-analyse.",
		"badge.aria": "Radarnaque-analyse openen",
		"severity.danger": "Ernstig",
		"severity.warning": "Let op",
		"severity.info": "Info",
		few_photos: "Weinig foto's ({count})",
		new_account: "Zeer recent verkopersaccount",
		no_reviews: "Geen beoordelingen voor de verkoper",
		foreign_location: "Verkoper buiten België ({country})",
		short_description: "Zeer korte beschrijving",
		contact_outside:
			"Vraagt om buiten het platform verder te gaan (telefoon, e-mail of chat)",
		shipping_only: "Alleen verzending, niet ophalen",
		offsite_payment:
			"Risicovolle betaalmethode (vooraf of buiten het platform)",
		symbolic_price: "Symbolische, abnormaal lage prijs",
		"ai.title": "AI-analyse",
		"ai.run": "AI-analyse starten",
		"ai.runPhotos": "Analyse met foto's",
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
			"Je hebt al je analyses van dit type voor deze periode gebruikt.",
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
		"ai.error.default": "Er is een fout opgetreden. Probeer het later opnieuw.",
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

// Remplace `{nom}` par la valeur du paramètre. Sans valeur, le placeholder est
// retiré avec la parenthèse qui l'entoure et l'espace qui le précède.
function interpolate(template: string, params: Signal["params"]): string {
	return template
		.replace(/\s*\(\{(\w+)\}\)/g, (whole, name: string) =>
			params?.[name] === undefined
				? ""
				: whole.replace(`{${name}}`, String(params[name])),
		)
		.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ""))
		.trim();
}

export function signalText(locale: Locale, signal: Signal): string {
	const template = (CONTENT_TEXTS[locale] as Partial<Record<RuleId, string>>)[
		signal.id
	];
	return template === undefined ? "" : interpolate(template, signal.params);
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
