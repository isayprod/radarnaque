import type { Locale } from "@radarnaque/shared";
import type { DeliveryResult } from "./deliver-session";

export type PageState = "pending" | DeliveryResult;

export const MESSAGES: Record<PageState, Record<Locale, string>> = {
	pending: {
		fr: "Connexion en cours…",
		nl: "Bezig met verbinden…",
	},
	connected: {
		fr: "Connecté ✓ Vous pouvez fermer cet onglet.",
		nl: "Verbonden ✓ U kunt dit tabblad sluiten.",
	},
	expired: {
		fr: "Lien expiré ou déjà utilisé. Demandez un nouveau lien depuis l'extension.",
		nl: "Link verlopen of al gebruikt. Vraag een nieuwe link aan via de extensie.",
	},
	"no-extension": {
		fr: "Ouvrez ce lien dans le navigateur où Radarnaque est installé, ou saisissez le code reçu par email dans l'extension.",
		nl: "Open deze link in de browser waar Radarnaque geïnstalleerd is, of voer de code uit de e-mail in de extensie in.",
	},
};

export function pickLocale(language: string | undefined | null): Locale {
	return language?.toLowerCase().startsWith("nl") ? "nl" : "fr";
}

/** `?lang=fr|nl` wins (language switch link); otherwise the browser language. */
export function detectLocale(
	search: string,
	language: string | undefined | null,
): Locale {
	const requested = new URLSearchParams(search).get("lang");
	if (requested === "fr" || requested === "nl") return requested;
	return pickLocale(language);
}
