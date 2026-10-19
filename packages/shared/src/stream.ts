/**
 * Événements de progression de `POST /api/scans/stream` (spec §8.3), écrits à la main :
 * miroir des événements SSE de l'API, absents du schéma OpenAPI. `result` et `error`
 * terminent le flux et n'en font pas partie.
 */

/** Ce que vérifie une recherche web lancée par le modèle. */
export type SearchAspect = "model" | "price" | "scam" | "other";

export type ScanProgressEvent =
	| {
			type: "stage";
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
