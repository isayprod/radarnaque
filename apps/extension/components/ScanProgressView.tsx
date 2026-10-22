import type { AnalysisResult, Locale } from "@radarnaque/shared";
import {
	eventLine,
	type ProgressStep,
	type ScanProgress,
	thinkingParts,
} from "../lib/content/scan-progress";
import { contentText } from "../lib/content-i18n";

type WebSearch = AnalysisResult["webSearches"][number];

/** Temps écoulé depuis le départ, à la seconde : « 3 s ». */
const elapsed = (at: number, startedAt: number) =>
	`${Math.max(0, Math.round((at - startedAt) / 1000))} s`;

function Step({
	step,
	startedAt,
	locale,
}: {
	step: ProgressStep;
	startedAt: number;
	locale: Locale;
}) {
	const { event } = step;
	const line = eventLine(event, locale);
	// Réflexion : sous son titre (la ligne), le reste du résumé, sans le répéter.
	const body = event.type === "thinking" ? thinkingParts(event.text).body : "";
	return (
		<li className="flex items-start gap-2">
			<span className="w-8 shrink-0 text-right text-text-2 tabular-nums">
				{elapsed(step.at, startedAt)}
			</span>
			<span className="min-w-0 break-words">
				<span className="block">{line}</span>
				{body && (
					<span className="block whitespace-pre-line text-text-2">{body}</span>
				)}
			</span>
		</li>
	);
}

/**
 * Déroulé d'une analyse : chaque étape, recherche (avec ses domaines) et résumé de
 * réflexion, avec le temps écoulé. En direct (`live`), la liste seule ; après
 * l'analyse, elle est repliée sous « Comment l'IA a analysé ». Les recherches gardées
 * en base (`webSearches`, résultat venu du cache) s'y ajoutent quand le déroulé n'en
 * a aucune. Tout texte du modèle est rendu en nœuds texte, jamais en HTML.
 */
export function ScanProgressView({
	progress,
	locale,
	webSearches = [],
	live,
}: {
	progress: ScanProgress | null;
	locale: Locale;
	webSearches?: WebSearch[];
	live: boolean;
}) {
	const steps = progress?.steps ?? [];
	const searched = steps.some((s) => s.event.type === "search");
	const stored = searched ? [] : webSearches;
	if (steps.length === 0 && stored.length === 0) return null;

	const list = (
		<ol className="m-0 flex max-h-[240px] list-none flex-col gap-1 overflow-auto p-0 text-[12px] leading-[1.4]">
			{progress &&
				steps.map((step, index) => (
					<Step
						// Les étapes ne sont jamais réordonnées ; une réflexion garde sa place.
						// biome-ignore lint/suspicious/noArrayIndexKey: liste qui ne fait que grandir
						key={index}
						step={step}
						startedAt={progress.startedAt}
						locale={locale}
					/>
				))}
			{stored.map((search, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: liste figée du serveur
				<li key={`stored-${index}`} className="break-words">
					{eventLine({ type: "search", id: index, ...search }, locale)}
				</li>
			))}
		</ol>
	);
	if (live) return list;
	return (
		// Repliée, à droite des analyses restantes (pied du panneau) ; dépliée, elle
		// prend toute la largeur, la liste alignée à gauche.
		<details className="ml-auto text-right text-[12px] leading-[1.4] open:w-full">
			<summary className="cursor-pointer font-medium text-text-2 hover:text-text-1 focus-visible:rounded-xs focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden">
				{contentText(locale, "ai.howAnalyzed")}
			</summary>
			<div className="mt-2 text-left text-text-2">{list}</div>
		</details>
	);
}
