import type { AnalysisResult, Locale } from "@radarnaque/shared";
import {
	eventLine,
	type ProgressStep,
	type ScanProgress,
} from "../lib/content/scan-progress";
import { contentText } from "../lib/content-i18n";

type WebSearch = AnalysisResult["webSearches"][number];

/** Temps écoulé depuis le départ, à la seconde : « 3 s ». */
const elapsed = (at: number, startedAt: number) =>
	`${Math.max(0, Math.round((at - startedAt) / 1000))} s`;

/** Résumé de réflexion entier, sans les marqueurs `**` du titre. */
const thinkingBody = (text: string) => text.replaceAll("**", "").trim();

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
	const body = event.type === "thinking" ? thinkingBody(event.text) : "";
	return (
		<li className="flex items-start gap-2">
			<span className="w-8 shrink-0 text-right text-slate-500 tabular-nums">
				{elapsed(step.at, startedAt)}
			</span>
			<span className="min-w-0 break-words">
				<span className="block">{line}</span>
				{body && body !== line && (
					<span className="block whitespace-pre-line text-slate-600">
						{body}
					</span>
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
		<details className="text-[12px]">
			<summary className="cursor-pointer font-semibold text-slate-700">
				{contentText(locale, "ai.howAnalyzed")}
			</summary>
			<div className="mt-1">{list}</div>
		</details>
	);
}
