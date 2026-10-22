import type { AnalysisResult } from "@radarnaque/shared";
import type { ScanState } from "./ai-client";

/**
 * Résultat IA à afficher : celui de l'analyse terminée ; `null` tant qu'elle ne
 * l'est pas (en cours, en erreur ou jamais lancée). L'analyse locale n'est plus
 * jamais affichée : sans résultat IA, la pastille montre « Analyser », la ligne
 * d'état ou l'erreur. Module à part : la pastille s'en sert même si la section
 * IA est remplacée.
 */
export function shownResult(ai: ScanState): AnalysisResult | null {
	return ai.status === "done" ? ai.result : null;
}
