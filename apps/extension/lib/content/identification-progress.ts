import type { IdentificationResult, SearchAspect } from "@radarnaque/shared";
import type { ScanProgress } from "./scan-progress";

/** Aspect affiché pour le type d'une recherche d'identification. */
const ASPECT: Record<
	IdentificationResult["searches"][number]["kind"],
	SearchAspect
> = {
	reference: "model",
	price: "price",
	criteria: "other",
	retry: "other",
};

/**
 * Déroulé reconstruit d'un résultat sans progression en direct (repris du
 * magasin ou servi par le cache) : chaque recherche, suivie des pages lues.
 * Les heures n'existent plus : la vue masque le temps écoulé (`timed={false}`).
 */
export function progressFromSearches(
	searches: IdentificationResult["searches"],
): ScanProgress {
	const steps: ScanProgress["steps"] = [];
	searches.forEach((search, id) => {
		steps.push({
			at: 0,
			event: {
				type: "search",
				id,
				query: search.query,
				aspect: ASPECT[search.kind] ?? "other",
			},
		});
		for (const domain of search.pagesRead)
			steps.push({ at: 0, event: { type: "page_read", domain, ok: true } });
	});
	return { startedAt: 0, steps, last: steps.at(-1)?.event ?? null, lastAt: 0 };
}
