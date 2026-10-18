/** Mots-clés de `shipping_only` : FR, NL, EN. */
export const SHIPPING_ONLY_KEYWORDS: readonly string[] = [
	"envoi uniquement",
	"pas de remise en main propre",
	"alleen verzenden",
	"geen ophalen",
	"shipping only",
];

/** Mots-clés de `abroad_seller` qui suffisent seuls : vendeur ou propriétaire à l'étranger (FR, NL). */
export const ABROAD_SELLER_KEYWORDS: readonly string[] = [
	"je suis à l'étranger",
	"actuellement à l'étranger",
	"vendeur à l'étranger",
	"propriétaire à l'étranger",
	"ik woon in het buitenland",
	"ik zit in het buitenland",
	"ik ben in het buitenland",
	"momenteel in het buitenland",
	"eigenaar in het buitenland",
];

/**
 * Envoi par transporteur : banal seul (« envoi par transporteur possible »), il ne
 * compte pour `abroad_seller` qu'avec un mot de `ABROAD_CONTEXT_KEYWORDS`.
 */
export const ABROAD_CARRIER_KEYWORDS: readonly string[] = [
	"envoi par transporteur",
	"livraison par transporteur",
	"via un transporteur",
	"verzending via koerier",
	"via een koerier",
	"via transporteur",
];

/** Étranger ou intermédiaire : rend suspect un envoi par transporteur (FR, NL). */
export const ABROAD_CONTEXT_KEYWORDS: readonly string[] = [
	"étranger",
	"buitenland",
	"intermédiaire",
	"tussenpersoon",
	"transportbedrijf",
];

/** Mots-clés de `contact_outside` qui invitent à écrire par email (FR, NL, EN). */
export const EMAIL_CONTACT_KEYWORDS: readonly string[] = [
	"contactez-moi par mail",
	"uniquement par mail",
	"enkel via mail",
];

/** « mail me » en mots entiers : ni « mail merci » ni « hotmail me » (sur le texte replié). */
export const MAIL_ME_RE = /(?<!\p{L})mail me(?!\p{L})/u;

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
	"caution avant la visite",
	"réservation payante",
	"waarborg vooraf",
	"eerst betalen",
	// Carte cadeau : seulement comme moyen de paiement (« carte cadeau Fnac à vendre » est honnête).
	"payer par carte cadeau",
	"paiement par carte cadeau",
	"paiement en carte cadeau",
	"betalen met cadeaukaart",
	"betaling met cadeaukaart",
	"cadeaukaart als betaling",
];

/** Mots-clés de `offsite_payment` ignorés juste après une négation (« pas d'acompte »). */
export const NEGATABLE_PAYMENT_KEYWORDS: readonly string[] = [
	"acompte",
	"voorschot",
];

/** Négations, en mots repliés : « d' » est un mot à part (« pas d'acompte »). */
const NEGATIONS: readonly (readonly string[])[] = [
	["pas", "d'"],
	["pas", "de"],
	["sans"],
	["aucun"],
	["geen"],
	["zonder"],
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

/** Vrai si l'un des 2 mots qui précèdent `prefix` (fin exclue) forme une négation. */
function endsWithNegation(prefix: string): boolean {
	// « d'acompte » : l'élision devient un mot ; la ponctuation sépare les mots.
	const words = prefix
		.replace(/'/g, "' ")
		.split(/[\s,;:.!?()«»"]+/)
		.filter(Boolean)
		.slice(-2);
	return NEGATIONS.some((neg) =>
		words.some((_, i) => neg.every((w, j) => words[i + j] === w)),
	);
}

/**
 * Vrai si `text` contient l'un des mots-clés hors négation : une occurrence
 * précédée (dans les 2 mots d'avant) de « pas d' », « pas de », « sans »,
 * « aucun », « geen » ou « zonder » ne compte pas ; une autre occurrence, si.
 */
export function containsUnnegatedKeyword(
	text: string,
	keywords: readonly string[],
): boolean {
	const folded = foldText(text);
	return keywords.some((k) => {
		const key = foldText(k);
		for (
			let i = folded.indexOf(key);
			i !== -1;
			i = folded.indexOf(key, i + key.length)
		) {
			if (!endsWithNegation(folded.slice(0, i))) return true;
		}
		return false;
	});
}

/** Vrai si `text` contient l'un des mots-clés, sans tenir compte des accents ni de la casse. */
export function containsKeyword(
	text: string,
	keywords: readonly string[],
): boolean {
	const folded = foldText(text);
	return keywords.some((k) => folded.includes(foldText(k)));
}
