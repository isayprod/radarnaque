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
	| Exclude<RuleId, "price_anomaly">;

export type ContentKey = Exclude<TextKey, RuleId>;

export const CONTENT_TEXTS: Record<Locale, Record<TextKey, string>> = {
	fr: {
		"level.low": "Risque faible",
		"level.medium": "Risque moyen",
		"level.high": "Risque élevé",
		"panel.title": "Analyse Radarnaque",
		"panel.none": "Aucun signal d'alerte détecté.",
		"panel.footer":
			"Analyse locale, sans IA. Pour une analyse approfondie, cliquez sur l'icône Radarnaque de votre navigateur.",
		"badge.aria": "Ouvrir l'analyse Radarnaque",
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
	},
	nl: {
		"level.low": "Laag risico",
		"level.medium": "Gemiddeld risico",
		"level.high": "Hoog risico",
		"panel.title": "Radarnaque-analyse",
		"panel.none": "Geen waarschuwingssignalen gevonden.",
		"panel.footer":
			"Lokale analyse, zonder AI. Voor een grondige analyse klikt u op het Radarnaque-pictogram in uw browser.",
		"badge.aria": "Radarnaque-analyse openen",
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
	},
};

export function contentText(locale: Locale, key: ContentKey): string {
	return CONTENT_TEXTS[locale][key];
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
