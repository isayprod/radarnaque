/** Mots-clés de `shipping_only` : FR, NL, EN. */
export const SHIPPING_ONLY_KEYWORDS: readonly string[] = [
	"envoi uniquement",
	"pas de remise en main propre",
	"alleen verzenden",
	"geen ophalen",
	"shipping only",
];

/** Mots-clés de `offsite_payment` : FR, NL, EN. */
export const OFFSITE_PAYMENT_KEYWORDS: readonly string[] = [
	"western union",
	"moneygram",
	"paiement à l'avance",
	"vooraf betalen",
	"lien de paiement",
	"betaallink",
	"paypal amis",
	"paypal vrienden",
	"friends and family",
	"payconiq vooraf",
];

/**
 * Forme comparable d'un texte : minuscules, sans accents (NFD), apostrophes
 * typographiques ramenées à `'`, espaces (dont U+00A0 et U+202F) réduits à un seul.
 */
export function foldText(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replace(/[‘’ʼ]/g, "'")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** Vrai si `text` contient l'un des mots-clés, sans tenir compte des accents ni de la casse. */
export function containsKeyword(
	text: string,
	keywords: readonly string[],
): boolean {
	const folded = foldText(text);
	return keywords.some((k) => folded.includes(foldText(k)));
}
