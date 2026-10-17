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
	"payconiq vooraf",
];

/** Ambigus seuls (« ideal for friends and family ») : comptent si « paypal » est aussi dans le texte. */
export const OFFSITE_PAYMENT_WITH_PAYPAL_KEYWORDS: readonly string[] = [
	"friends and family",
];

/**
 * Forme comparable d'un texte : minuscules, apostrophes typographiques
 * (‘ ’ ʼ ´ `) ramenées à `'`, puis accents retirés (NFD, marques combinantes
 * seulement), espaces (dont U+00A0 et U+202F) réduits à un seul.
 */
export function foldText(s: string): string {
	return s
		.replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
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
