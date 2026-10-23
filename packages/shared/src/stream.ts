import type { components } from "./api";

type IdentificationOut = components["schemas"]["IdentificationOut"];

/** Résultat d'une identification : la fin d'un flux `identify`, ou le champ `identification` d'un scan. */
export type IdentificationResult = IdentificationOut;

/**
 * Événements de progression de `POST /api/scans/stream` (spec §8.3), écrits à la main :
 * miroir des événements SSE de l'API, absents du schéma OpenAPI. `result` et `error`
 * terminent le flux et n'en font pas partie.
 */

/** Étapes de `stage` : celles de l'identification (`reading_photos` à `retrying`) s'ajoutent. */
export type StreamStage =
	| "cache"
	| "photos"
	| "analyzing"
	| "reading_photos"
	| "criteria"
	| "identifying"
	| "retrying"
	| "writing";

/** Ce que vérifie une recherche web lancée par le modèle. */
export type SearchAspect = "model" | "price" | "scam" | "other";

export type ScanProgressEvent =
	| {
			type: "stage";
			stage: StreamStage;
			/** Photos à télécharger (`photos`) ou envoyées au modèle (`analyzing`). */
			count?: number;
	  }
	/** Résumé de réflexion, cumulé par partie : chaque événement remplace le précédent de la partie. */
	| { type: "thinking"; part: number; text: string }
	| { type: "search"; id: number; query: string; aspect: SearchAspect }
	| {
			type: "search_done";
			id: number;
			ok: boolean;
			count: number;
			domains: string[];
	  }
	| PageReadEvent
	| CriteriaCachedEvent
	| IdentificationErrorEvent
	| IdentificationEvent;

/** Page lue pour l'identification ; `ok` faux : refusée ou en échec. */
export type PageReadEvent = { type: "page_read"; domain: string; ok: boolean };

/** Critères de distinction repris de la base partagée. */
export type CriteriaCachedEvent = { type: "criteria_cached"; count: number };

/** L'identification a échoué pendant un scan : le flux continue (contrairement à `error`). */
export type IdentificationErrorEvent = {
	type: "identification_error";
	code: string;
};

/**
 * Identification terminée : les champs de `IdentificationOut`, à plat (comme l'événement SSE),
 * `debug` absent plutôt que nul hors superuser.
 */
export type IdentificationEvent = { type: "identification" } & Omit<
	IdentificationOut,
	"debug"
> & { debug?: IdentificationOut["debug"] };
