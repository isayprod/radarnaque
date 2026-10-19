import type { AnalysisResult } from "@radarnaque/shared";
import type { ScanState } from "./ai-client";

/**
 * Résultat IA à afficher à la place de l'analyse locale : celui de l'analyse
 * terminée ; `null` tant qu'elle ne l'est pas (en cours, en erreur ou jamais
 * lancée). La pastille et le panneau restent alors sur l'analyse locale.
 * Module à part : la pastille s'en sert même si la section IA est remplacée.
 */
export function shownResult(ai: ScanState): AnalysisResult | null {
	return ai.status === "done" ? ai.result : null;
}
