import type { Listing } from "../listing/types";
import type { RuleId, Signal } from "./rules";
import { RULES, RULES_VERSION } from "./rules";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskReport {
	score: number;
	level: RiskLevel;
	signals: Signal[];
	rulesVersion: number;
}

const MAX_SCORE = 100;

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
 * Somme des poids des signaux, plafonnée à 100. Ignore les règles `enabled: false`
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
	const signals: Signal[] = [];
	for (const rule of RULES) {
		if (!rule.enabled || skipped.has(rule.id)) continue;
		const signal = rule.check(listing);
		if (signal) signals.push(signal);
	}
	const score = Math.min(
		MAX_SCORE,
		signals.reduce((sum, s) => sum + s.weight, 0),
	);
	return { score, level: levelOf(score), signals, rulesVersion: RULES_VERSION };
}
