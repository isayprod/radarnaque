import { normalizeText } from "../listing/parse";
import type { Listing } from "../listing/types";
import {
	ABROAD_CARRIER_KEYWORDS,
	ABROAD_CONTEXT_KEYWORDS,
	ABROAD_SELLER_KEYWORDS,
	containsKeyword,
	containsUnnegatedKeyword,
	EMAIL_CONTACT_KEYWORDS,
	foldText,
	MAIL_ME_RE,
	NEGATABLE_PAYMENT_KEYWORDS,
	OFFSITE_PAYMENT_KEYWORDS,
	OFFSITE_PAYMENT_WITH_PAYPAL_KEYWORDS,
	SHIPPING_ONLY_KEYWORDS,
} from "./keywords";

export const RULES_VERSION = 4;

export type Severity = "info" | "warning" | "danger";
export type RuleId =
	| "few_photos"
	| "new_account"
	| "no_reviews"
	| "foreign_location"
	| "abroad_seller"
	| "short_description"
	| "contact_outside"
	| "shipping_only"
	| "offsite_payment"
	| "symbolic_price"
	| "price_anomaly";

export interface Signal {
	id: RuleId;
	weight: number;
	severity: Severity;
	params?: Record<string, string | number>;
}

export interface Rule {
	id: RuleId;
	weight: number;
	severity: Severity;
	enabled: boolean;
	check(l: Listing): Signal | null;
}

// Testées sur le texte en minuscules. `(?<!\d)` et `(?!\d)` évitent de lire un
// téléphone au milieu d'un nombre (prix, référence). L'international exige 9 à
// 14 chiffres au total, pour écarter « +15 °C », « +50 000 km » ou « S23+ 256 ».
const PHONE_RES: readonly RegExp[] = [
	/(?<!\d)(\+32|0032|0)\s?4\d{2}([\s./-]?\d{2}){3}(?!\d)/,
	/(?<!\d)(\+32|0032|0)\s?4\d{2}[\s./-]?\d{3}[\s./-]?\d{3}(?!\d)/,
	/(?<!\d)\+(?=(?:[\s./-]?\d){9,14}(?!\d))\d{2,3}[\s./-]?\d{1,3}(?:[\s./-]?\d{2,4}){2,4}(?!\d)/,
];
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
const APP_RES: readonly RegExp[] = [
	/whatsapp|whats app|(?<![a-z0-9.-])wa\.me|telegram|(?<![a-z0-9.-])t\.me\//,
	/\b(sur|via|op) signal\b|\bsignal app\b/,
];

function contactKind(l: Listing): "phone" | "email" | "app" | null {
	const text = normalizeText(`${l.title} ${l.description}`).toLowerCase();
	if (PHONE_RES.some((re) => re.test(text))) return "phone";
	if (EMAIL_RE.test(text)) return "email";
	if (APP_RES.some((re) => re.test(text))) return "app";
	// Après les applis : « mail me sur signal » reste un contact par appli.
	if (
		containsKeyword(text, EMAIL_CONTACT_KEYWORDS) ||
		MAIL_ME_RE.test(foldText(text))
	)
		return "email";
	return null;
}

function rule(
	id: RuleId,
	weight: number,
	severity: Severity,
	check: (l: Listing) => Signal["params"] | boolean,
	enabled = true,
): Rule {
	return {
		id,
		weight,
		severity,
		enabled,
		check(l) {
			const result = check(l);
			if (!result) return null;
			const signal: Signal = { id, weight, severity };
			if (typeof result === "object") signal.params = result;
			return signal;
		},
	};
}

function text(l: Listing): string {
	return `${l.title} ${l.description}`;
}

export const RULES: readonly Rule[] = [
	rule("few_photos", 15, "warning", (l) =>
		l.images.length <= 1 ? { count: l.images.length } : false,
	),
	rule(
		"new_account",
		25,
		"danger",
		(l) =>
			l.seller.accountAgeMonths !== undefined &&
			l.seller.accountAgeMonths.max < 3,
	),
	rule("no_reviews", 10, "warning", (l) => l.seller.reviewCount === 0),
	rule("foreign_location", 20, "warning", (l) => {
		const country = l.location.country;
		return country !== undefined && country !== "BE" ? { country } : false;
	}),
	rule(
		"abroad_seller",
		20,
		"warning",
		(l) =>
			containsKeyword(text(l), ABROAD_SELLER_KEYWORDS) ||
			(containsKeyword(text(l), ABROAD_CARRIER_KEYWORDS) &&
				containsKeyword(text(l), ABROAD_CONTEXT_KEYWORDS)),
	),
	rule(
		"short_description",
		10,
		"info",
		(l) => l.description.trim().length < 30,
	),
	rule("contact_outside", 25, "danger", (l) => {
		const kind = contactKind(l);
		return kind ? { kind } : false;
	}),
	rule("shipping_only", 15, "warning", (l) =>
		containsKeyword(text(l), SHIPPING_ONLY_KEYWORDS),
	),
	rule(
		"offsite_payment",
		35,
		"danger",
		(l) =>
			containsKeyword(text(l), OFFSITE_PAYMENT_KEYWORDS) ||
			containsUnnegatedKeyword(text(l), NEGATABLE_PAYMENT_KEYWORDS) ||
			(containsKeyword(text(l), ["paypal"]) &&
				containsKeyword(text(l), OFFSITE_PAYMENT_WITH_PAYPAL_KEYWORDS)),
	),
	rule(
		"symbolic_price",
		20,
		"warning",
		(l) =>
			l.priceType === "fixed" &&
			l.price !== null &&
			l.price.amountCents >= 0 &&
			l.price.amountCents <= 100,
	),
	// Désactivée : présente dans le registre, jamais évaluée.
	rule("price_anomaly", 0, "info", () => false, false),
];
