import type { Locale, ScanProgressEvent } from "@radarnaque/shared";
import { type ContentKey, contentText } from "../content-i18n";
import { cut } from "../scan-payload";

/** Étapes gardées au plus pour le déroulé : les plus anciennes sont retirées. */
export const MAX_PROGRESS_STEPS = 100;

/** Longueur maximale de la ligne d'état, « … » compris (spec §10.2). */
export const STATUS_LINE_MAX = 60;

/** Un événement reçu, avec son heure de réception (millisecondes epoch). */
export interface ProgressStep {
	at: number;
	event: ScanProgressEvent;
}

/** Progression d'une analyse en cours, pour la ligne d'état et le déroulé du panneau. */
export interface ScanProgress {
	startedAt: number;
	steps: ProgressStep[];
	/** Dernier événement reçu ; null avant le premier. */
	last: ScanProgressEvent | null;
	/** Heure du dernier événement (ou du départ) : sert à détecter une attente. */
	lastAt: number;
}

export const startProgress = (now: number): ScanProgress => ({
	startedAt: now,
	steps: [],
	last: null,
	lastAt: now,
});

/**
 * Nouvelle progression avec l'événement `e` ; `p` n'est pas modifiée (état React).
 * Un `thinking` est cumulé par partie : celui d'une partie déjà vue remplace son étape,
 * qui garde sa place et son heure. Au plus `MAX_PROGRESS_STEPS` étapes.
 */
export function addEvent(
	p: ScanProgress,
	e: ScanProgressEvent,
	now: number,
): ScanProgress {
	const same =
		e.type === "thinking"
			? p.steps.findLastIndex(
					(s) => s.event.type === "thinking" && s.event.part === e.part,
				)
			: -1;
	const steps =
		same >= 0
			? p.steps.map((s, i) => (i === same ? { at: s.at, event: e } : s))
			: [...p.steps, { at: now, event: e }].slice(-MAX_PROGRESS_STEPS);
	return { ...p, steps, last: e, lastAt: now };
}

/** Espaces resserrés, sauts de ligne compris. */
const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();

/** Phrases d'un texte : coupées aux sauts de ligne et après `.`, `!`, `?` ou `…`. */
const SENTENCE_BREAK = /\n|(?<=[.!?…])\s+/;

/**
 * Titre et corps d'un résumé de réflexion. Le titre est le premier segment `**…**`
 * non vide, sinon la dernière phrase non vide ; le corps est le reste du texte, sans
 * le titre ni les `**` restants (sauts de ligne gardés). Le résumé arrive cumulé : un
 * `**` ouvrant sans fermant est un titre en cours, rendu tel qu'il est déjà arrivé.
 * Le texte reste celui du modèle ; le titre a ses espaces resserrés.
 */
export function thinkingParts(text: string): { title: string; body: string } {
	// Entre deux `**` : les morceaux d'indice impair. Le dernier, s'il est impair,
	// n'a pas encore de marqueur fermant.
	const parts = text.split("**");
	for (let i = 1; i < parts.length; i += 2) {
		const title = squeeze(parts[i] ?? "");
		if (title) {
			const body = parts
				.filter((_, j) => j !== i)
				.join("")
				.trim();
			return { title, body };
		}
	}
	const sentences = parts
		.join("")
		.split(SENTENCE_BREAK)
		.map(squeeze)
		.filter(Boolean);
	return {
		title: sentences.at(-1) ?? "",
		body: sentences.slice(0, -1).join(" "),
	};
}

/** Titre d'un résumé de réflexion (voir `thinkingParts`) : la ligne d'état. */
export const thinkingTitle = (text: string): string =>
	thinkingParts(text).title;

/** Remplit `{nom}` en une passe : une requête qui contient `{…}` reste telle quelle. */
const fill = (template: string, params: Record<string, string | number>) =>
	template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : whole,
	);

type Stage = Extract<ScanProgressEvent, { type: "stage" }>;

function stageLine(e: Stage, t: (key: ContentKey) => string): string {
	const count = e.count ?? 0;
	switch (e.stage) {
		case "cache":
			return t("progress.cache");
		case "photos":
			return count === 1
				? t("progress.photosOne")
				: fill(t("progress.photos"), { count });
		case "analyzing":
			if (count === 0) return t("progress.analyzingNone");
			return count === 1
				? t("progress.analyzingOne")
				: fill(t("progress.analyzing"), { count });
		case "writing":
			return t("progress.writing");
	}
}

/**
 * Texte d'un événement, sans limite de longueur (le déroulé du panneau) ; vide pour
 * un résumé de réflexion encore vide. La ligne d'état le coupe (`statusLine`).
 */
export function eventLine(e: ScanProgressEvent, locale: Locale): string {
	const t = (key: ContentKey) => contentText(locale, key);
	switch (e.type) {
		case "stage":
			return stageLine(e, t);
		case "thinking":
			return thinkingTitle(e.text);
		case "search":
			return fill(t("progress.search"), {
				aspect: t(`progress.aspect.${e.aspect}`),
				query: squeeze(e.query),
			});
		case "search_done": {
			if (!e.ok) return t("progress.searchFailed");
			// Règles de chaque langue : « 0 résultat » en FR, « 0 resultaten » en NL.
			const one = new Intl.PluralRules(locale).select(e.count) === "one";
			const results = fill(
				t(one ? "progress.resultsOne" : "progress.results"),
				{ count: e.count },
			);
			if (e.domains.length === 0) return results;
			return fill(t("progress.searchDone"), {
				results,
				domains: e.domains.join(", "),
			});
		}
	}
}

/** Coupe à `STATUS_LINE_MAX` points de code, « … » compris. */
function clip(line: string): string {
	if (Array.from(line).length <= STATUS_LINE_MAX) return line;
	return `${cut(line, STATUS_LINE_MAX - 1).trimEnd()}…`;
}

/**
 * Ligne d'état de la pastille : le texte du dernier événement, ou de l'étape la plus
 * récente qui en a un (un résumé de réflexion encore vide ne l'efface pas).
 */
export function statusLine(p: ScanProgress, locale: Locale): string {
	const events = p.steps.map((s) => s.event);
	if (p.last && events.at(-1) !== p.last) events.push(p.last);
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		const line = event ? eventLine(event, locale) : "";
		if (line) return clip(line);
	}
	return clip(contentText(locale, "progress.start"));
}
