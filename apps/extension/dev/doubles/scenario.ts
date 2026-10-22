import type { Locale } from "@radarnaque/shared";

/**
 * Scénario de la page `popup.html` de la galerie, lu dans l'adresse :
 * `?state=loading|signedOut|codeSent|signedIn|unlimited|unavailable`,
 * `?lang=fr|nl`, `?delete=open|typed` (section de suppression dépliée, mot tapé ou non).
 */
export type PopupState =
	| "loading"
	| "signedOut"
	| "codeSent"
	| "signedIn"
	| "unlimited"
	| "unavailable";

export const POPUP_STATES: readonly PopupState[] = [
	"loading",
	"signedOut",
	"codeSent",
	"signedIn",
	"unlimited",
	"unavailable",
];

const params = new URLSearchParams(globalThis.location?.search ?? "");

function pick<T extends string>(
	value: string | null,
	allowed: readonly T[],
	fallback: T,
): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

export const SCENARIO = {
	state: pick(params.get("state"), POPUP_STATES, "signedOut"),
	lang: pick<Locale>(params.get("lang"), ["fr", "nl"], "fr"),
	deletion: pick(params.get("delete"), ["closed", "open", "typed"], "closed"),
};

/** Adresse fictive de l'écran du code et du compte. */
export const DEMO_EMAIL = "camille.exemple@radarnaque.test";
