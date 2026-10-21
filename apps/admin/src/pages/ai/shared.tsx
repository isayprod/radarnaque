import type { components } from "@radarnaque/shared";
import { ApiFailure } from "../../api";

export type Overview = components["schemas"]["AiOverviewOut"];

export const LIMIT_MESSAGE =
	"Limite d'essais atteinte, réessayez dans une heure.";

/** Texte d'une erreur d'essai : la limite horaire a son propre message. */
export function probeMessage(error: unknown): string {
	if (error instanceof ApiFailure && error.status === 429) {
		return LIMIT_MESSAGE;
	}
	return "L'essai a échoué, réessayez.";
}
