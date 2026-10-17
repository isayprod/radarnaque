import type { ContentKey } from "../lib/content-i18n";
import type { Severity } from "../lib/rules/rules";
import type { RiskLevel } from "../lib/rules/score";

// Styles communs à la pastille locale et à la section IA : un même niveau, une même
// gravité ont toujours le même rendu, quelle que soit l'origine de l'analyse.

export const LEVEL_KEY: Record<RiskLevel, ContentKey> = {
	low: "level.low",
	medium: "level.medium",
	high: "level.high",
};

// Couleur du point et du texte de niveau. Le niveau est toujours aussi écrit en
// toutes lettres : la couleur ne porte jamais seule l'information.
export const LEVEL_STYLE: Record<RiskLevel, { dot: string; text: string }> = {
	low: { dot: "bg-green-600", text: "text-green-800" },
	medium: { dot: "bg-amber-500", text: "text-amber-800" },
	high: { dot: "bg-red-600", text: "text-red-800" },
};

export const SEVERITY_STYLE: Record<Severity, string> = {
	danger: "bg-red-100 text-red-800",
	warning: "bg-amber-100 text-amber-800",
	info: "bg-slate-100 text-slate-700",
};
