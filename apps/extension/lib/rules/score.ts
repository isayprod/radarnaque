import type { Listing } from "../listing/types";
import type { RuleId, Severity, Signal } from "./rules";
import { RULES, RULES_VERSION } from "./rules";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskReport {
	score: number;
	level: RiskLevel;
	signals: Signal[];
	rulesVersion: number;
}

const MAX_SCORE = 100;

/** Prix fixe sous ce seuil (en centimes) : objet de faible valeur, l'arnaque y est rare. */
export const LOW_VALUE_PRICE_CENTS = 3000;

/** Signaux faibles, atténués de moitié pour un objet de faible valeur. */
export const LOW_VALUE_WEAK_SIGNALS: ReadonlySet<RuleId> = new Set<RuleId>([
	"few_photos",
	"no_reviews",
	"new_account",
	"short_description",
]);

/** Gravité d'un signal atténué, si elle change : un compte récent à 12 n'est plus un danger. */
const LOW_VALUE_SEVERITY: Partial<Record<RuleId, Severity>> = {
	new_account: "warning",
};

/** Signal atténué de moitié (arrondi inférieur), gravité ajustée selon `LOW_VALUE_SEVERITY`. */
function damp(signal: Signal): Signal {
	return {
		...signal,
		weight: Math.floor(signal.weight / 2),
		severity: LOW_VALUE_SEVERITY[signal.id] ?? signal.severity,
	};
}

function isLowValue(listing: Listing): boolean {
	return (
		listing.priceType === "fixed" &&
		listing.price !== null &&
		listing.price.amountCents < LOW_VALUE_PRICE_CENTS
	);
}

/** Champ que l'adaptateur n'a pas pu lire : la règle qui en dépend n'est pas évaluée. */
export type UnknownField = "description" | "images";

const RULE_OF_UNKNOWN_FIELD: Record<UnknownField, RuleId> = {
	description: "short_description",
	images: "few_photos",
};

/** `low` de 0 à 29, `medium` de 30 à 59, `high` à partir de 60. */
export function levelOf(score: number): RiskLevel {
	if (score >= 60) return "high";
	if (score >= 30) return "medium";
	return "low";
}

/**
 * Somme des poids des signaux, plafonnée à 100. Pour un objet de faible valeur,
 * les signaux faibles pèsent la moitié de leur poids (arrondi inférieur) : le
 * poids atténué est celui du signal renvoyé, donc celui que reçoit le serveur.
 * Un `new_account` atténué passe en `warning` ; les autres gardent leur gravité.
 * Ignore les règles `enabled: false`
 * et celles dont le champ est dans `opts.unknown`.
 */
export function evaluate(
	listing: Listing,
	opts?: { unknown?: ReadonlySet<UnknownField> },
): RiskReport {
	const skipped = new Set<RuleId>();
	for (const field of opts?.unknown ?? []) {
		skipped.add(RULE_OF_UNKNOWN_FIELD[field]);
	}
	const lowValue = isLowValue(listing);
	const signals: Signal[] = [];
	for (const rule of RULES) {
		if (!rule.enabled || skipped.has(rule.id)) continue;
		const signal = rule.check(listing);
		if (!signal) continue;
		signals.push(
			lowValue && LOW_VALUE_WEAK_SIGNALS.has(signal.id) ? damp(signal) : signal,
		);
	}
	const score = Math.min(
		MAX_SCORE,
		signals.reduce((sum, s) => sum + s.weight, 0),
	);
	return { score, level: levelOf(score), signals, rulesVersion: RULES_VERSION };
}
