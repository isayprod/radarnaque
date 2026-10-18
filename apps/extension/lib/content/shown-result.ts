import type { AnalysisResult } from "@radarnaque/shared";
import type { ScanKind } from "../messages";
import type { ScanState } from "./ai-client";

/** Résultat IA affiché à la place de l'analyse locale, et son type de scan. */
export interface ShownResult {
	kind: ScanKind;
	result: AnalysisResult;
}

/**
 * Résultat IA à afficher : celui des photos s'il est terminé, sinon celui du
 * texte ; `null` tant qu'aucun scan n'est terminé (en cours, en erreur ou
 * jamais lancé). La pastille et le panneau restent alors sur l'analyse locale.
 * Module à part : la pastille s'en sert même si la section IA est remplacée.
 */
export function shownResult(
	text: ScanState,
	image: ScanState,
): ShownResult | null {
	if (image.status === "done") return { kind: "image", result: image.result };
	if (text.status === "done") return { kind: "text", result: text.result };
	return null;
}
