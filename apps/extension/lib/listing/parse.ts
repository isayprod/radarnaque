import type { Listing } from "./types";

export type MonthRange = { min: number; max: number };

/** Réduit les espaces (dont U+00A0, U+202F, U+2009) à un seul espace ordinaire, puis rogne. */
export function normalizeText(s: string): string {
	return s.replace(/[\s   ]+/g, " ").trim();
}

const FREE_RE = /^(gratuit|gratis|free)$/i;
const CURRENCY_RE = /€|\beur\b/i;
// Milliers : espace ou point, par groupes de 3 chiffres ; décimales : virgule.
const AMOUNT_RE = /^(\d{1,3}(?:[ .]\d{3})+|\d+)(?:,(\d{1,2}))?$/;

/**
 * Lit un prix affiché. Renvoie null dès que le texte n'est pas clairement un
 * prix en euros : un prix mal lu ne doit jamais devenir un montant faux.
 */
export function parsePriceText(
	text: string,
): { price: Listing["price"]; priceType: Listing["priceType"] } | null {
	const t = normalizeText(text);
	if (!t) return null;
	if (FREE_RE.test(t)) return { price: null, priceType: "free" };
	if (!CURRENCY_RE.test(t)) return null;

	const m = AMOUNT_RE.exec(t.replace(/€|\beur\b/gi, "").trim());
	if (!m?.[1]) return null;
	const whole = Number(m[1].replace(/[ .]/g, ""));
	const decimals = Number((m[2] ?? "").padEnd(2, "0") || "0");
	return {
		price: { amountCents: whole * 100 + decimals, currency: "EUR" },
		priceType: "fixed",
	};
}

const AGE_RE =
	/(\d+)\s*(ans?|jaar|jaren|mois|maanden?|semaines?|weken|week|jours?|dagen|dag)\b/i;

/**
 * Ancienneté affichée (« 10 ans », « 6 maanden »). Une durée en années ne donne
 * que l'année entière : fourchette de 12 mois. Les durées plus courtes que
 * 1 mois valent 0.
 */
export function parseAccountAge(text: string): MonthRange | null {
	const m = AGE_RE.exec(normalizeText(text));
	if (!m?.[1] || !m[2]) return null;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	if (/^(an|ans|jaar|jaren)$/.test(unit))
		return { min: n * 12, max: n * 12 + 11 };
	if (/^(mois|maand|maanden)$/.test(unit)) return { min: n, max: n };
	return { min: 0, max: 0 };
}

function fullMonthsBetween(from: Date, to: Date): number {
	let months =
		(to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
		(to.getUTCMonth() - from.getUTCMonth());
	const rest = (d: Date) =>
		((d.getUTCDate() * 24 + d.getUTCHours()) * 60 + d.getUTCMinutes()) * 60 +
		d.getUTCSeconds();
	if (rest(to) < rest(from)) months -= 1;
	return months;
}

/**
 * « A rejoint Facebook en 2007 » : seule l'année est connue.
 * max = mois complets depuis le 1er janvier ; min = depuis le 31 décembre (plancher 0).
 */
export function parseFacebookJoinYear(
	text: string,
	now: Date,
): MonthRange | null {
	const m = /\b(19|20)\d{2}\b/.exec(normalizeText(text));
	if (!m) return null;
	const year = Number(m[0]);
	const max = fullMonthsBetween(new Date(Date.UTC(year, 0, 1)), now);
	const min = fullMonthsBetween(new Date(Date.UTC(year, 11, 31)), now);
	return { min: Math.max(0, min), max: Math.max(0, max) };
}
