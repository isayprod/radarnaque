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
			/** Étapes que l'extension traite ; `StreamStage` ajoute celles de l'identification. */
			stage: "cache" | "photos" | "analyzing" | "writing";
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
	  };

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
 * Identification terminée : les champs de `IdentificationOut`, à plat (comme l'événement SSE).
 * Typage complet quand `IdentificationOut` entrera dans le schéma OpenAPI généré.
 */
export type IdentificationEvent = {
	type: "identification";
	identificationId: number;
	status: "identified" | "uncertain" | "none";
} & Record<string, unknown>;
