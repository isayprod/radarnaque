import type { Listing } from "../listing/types";
import type { Signal } from "./rules";
import { RULES, RULES_VERSION } from "./rules";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskReport {
	score: number;
	level: RiskLevel;
	signals: Signal[];
	rulesVersion: number;
}

const MAX_SCORE = 100;

/** `low` de 0 à 29, `medium` de 30 à 59, `high` à partir de 60. */
export function levelOf(score: number): RiskLevel {
	if (score >= 60) return "high";
	if (score >= 30) return "medium";
	return "low";
}

/** Somme des poids des signaux, plafonnée à 100. Ignore les règles `enabled: false`. */
export function evaluate(listing: Listing): RiskReport {
	const signals: Signal[] = [];
	for (const rule of RULES) {
		if (!rule.enabled) continue;
		const signal = rule.check(listing);
		if (signal) signals.push(signal);
	}
	const score = Math.min(
		MAX_SCORE,
		signals.reduce((sum, s) => sum + s.weight, 0),
	);
	return { score, level: levelOf(score), signals, rulesVersion: RULES_VERSION };
}
