/** Mots-clés de `shipping_only` : FR, NL, EN. */
export const SHIPPING_ONLY_KEYWORDS: readonly string[] = [
	"envoi uniquement",
	"pas de remise en main propre",
	"alleen verzenden",
	"geen ophalen",
	"shipping only",
];

/** Mots-clés de `abroad_seller` : vendeur ou objet à l'étranger, envoi par transporteur (FR, NL). */
export const ABROAD_SELLER_KEYWORDS: readonly string[] = [
	"je suis à l'étranger",
	"actuellement à l'étranger",
	"envoi par transporteur",
	"livraison par transporteur",
	"via un transporteur",
	"in het buitenland",
	"momenteel in het buitenland",
	"verzending via koerier",
	"via een koerier",
	"via transporteur",
];

/** Mots-clés de `contact_outside` qui invitent à écrire par email (FR, NL, EN). */
export const EMAIL_CONTACT_KEYWORDS: readonly string[] = [
	"contactez-moi par mail",
	"uniquement par mail",
	"enkel via mail",
	"mail me",
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
	"acompte",
	"caution avant la visite",
	"réservation payante",
	"voorschot",
	"waarborg vooraf",
	"eerst betalen",
	"carte cadeau",
	"cadeaukaart",
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
