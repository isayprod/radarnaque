import type { ContentKey } from "../lib/content-i18n";
import type { Severity } from "../lib/rules/rules";
import type { RiskLevel } from "../lib/rules/score";

// Styles communs à la pastille, aux icônes de cartes et à la section IA : un même
// niveau, une même gravité (raisons de l'IA) ont toujours le même rendu.

export const LEVEL_KEY: Record<RiskLevel, ContentKey> = {
	low: "level.low",
	medium: "level.medium",
	high: "level.high",
};

// Couleurs sémantiques des tokens (DESIGN.md §2.2) : point, texte, fond doux (badge
// de verdict) et barre du score. Le niveau est toujours aussi écrit en toutes
// lettres : la couleur ne porte jamais seule l'information.
export const LEVEL_STYLE: Record<
	RiskLevel,
	{ dot: string; text: string; soft: string; bar: string }
> = {
	low: {
		dot: "bg-success",
		text: "text-success",
		soft: "bg-success-soft",
		bar: "bg-success",
	},
	medium: {
		dot: "bg-warning",
		text: "text-warning",
		soft: "bg-warning-soft",
		bar: "bg-warning",
	},
	high: {
		dot: "bg-danger",
		text: "text-danger",
		soft: "bg-danger-soft",
		bar: "bg-danger",
	},
};

// Badges de gravité des raisons de l'IA : fond doux et texte de la même couleur.
export const SEVERITY_STYLE: Record<Severity, string> = {
	danger: "bg-danger-soft text-danger",
	warning: "bg-warning-soft text-warning",
	info: "bg-info-soft text-info",
};

/**
 * Style `label` (DESIGN.md) : 11 px, majuscules, interlettrage 0,06 em, poids 500.
 * Titre du panneau, « Conseil » et « Pourquoi ».
 */
export const LABEL_CLASS =
	"m-0 text-[11px] leading-[1.3] font-medium tracking-[0.06em] text-text-2 uppercase";
