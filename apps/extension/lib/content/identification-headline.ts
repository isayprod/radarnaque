import type { IdentificationResult, Locale } from "@radarnaque/shared";
import { type ContentKey, contentText } from "../content-i18n";
import { cut } from "../scan-payload";

/** Longueur maximale d'une référence dans la pilule, « … » compris (spec §13.1). */
export const REFERENCE_MAX = 32;

export type ConfidenceLevel = IdentificationResult["level"];

/**
 * Glyphe de confiance : la seule marque visuelle du niveau, jamais une couleur
 * sémantique du risque. Le niveau est toujours aussi écrit (`CONFIDENCE_KEY`).
 */
export const CONFIDENCE_GLYPH: Record<ConfidenceLevel, string> = {
	sure: "●",
	probable: "◐",
	uncertain: "○",
};

export const CONFIDENCE_KEY: Record<ConfidenceLevel, ContentKey> = {
	sure: "identify.level.sure",
	probable: "identify.level.probable",
	uncertain: "identify.level.uncertain",
};

/** Coupe à `REFERENCE_MAX` points de code, « … » compris. */
export function shortReference(text: string): string {
	if (Array.from(text).length <= REFERENCE_MAX) return text;
	return `${cut(text, REFERENCE_MAX - 1).trimEnd()}…`;
}

/** Ce que la pilule et l'en-tête du panneau disent d'une identification. */
export interface IdentificationHeadline {
	/** Référence complète, ou « A ou B ? » : le nom accessible. */
	reference: string;
	/** La même, chaque référence coupée à `REFERENCE_MAX` : le texte affiché. */
	short: string;
	glyph: string;
	/** Niveau en toutes lettres (« Sûr »). */
	level: string;
	/** Pourcentage (« 95 % ») : chiffres tabulaires à l'affichage. */
	percent: string;
}

/**
 * Titre d'une identification : la référence de l'objet principal, ou ses deux
 * premiers candidats quand elle manque (« A ou B ? »), avec le niveau et le
 * pourcentage de l'identification. Null quand rien n'est identifiable (statut
 * `none`, aucun objet) : « Produit non identifié ».
 */
export function identificationHeadline(
	result: IdentificationResult,
	locale: Locale,
): IdentificationHeadline | null {
	const main =
		result.objects.find((object) => object.role === "main") ??
		result.objects[0];
	if (result.status === "none" || !main) return null;
	const either = (a: string, b: string) =>
		contentText(locale, "identify.either")
			.replace("{a}", () => a)
			.replace("{b}", () => b);
	const [first, second] = main.remaining;
	let reference: string;
	let short: string;
	if (main.reference) {
		reference = main.reference;
		short = shortReference(reference);
	} else if (first !== undefined && second !== undefined) {
		reference = either(first, second);
		short = either(shortReference(first), shortReference(second));
	} else {
		// Un seul candidat, ou aucun : lui, sinon le libellé de l'objet.
		reference = first || main.label || "?";
		short = shortReference(reference);
	}
	return {
		reference,
		short,
		glyph: CONFIDENCE_GLYPH[result.level],
		level: contentText(locale, CONFIDENCE_KEY[result.level]),
		percent: contentText(locale, "identify.percent").replace(
			"{count}",
			String(result.confidence),
		),
	};
}
