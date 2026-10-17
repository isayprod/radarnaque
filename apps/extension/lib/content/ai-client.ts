import type { AnalysisResult } from "@radarnaque/shared";
import {
	type BgResponse,
	type ContentAccess,
	type ScanRequest,
	sendToBackground,
} from "../messages";

/**
 * Accès du content script aux analyses IA. Tout passe par le service worker, seul
 * face à l'API : le content script n'envoie que des messages de la liste blanche.
 */
export interface AiClient {
	access(): Promise<BgResponse<ContentAccess>>;
	scan(req: ScanRequest): Promise<BgResponse<AnalysisResult>>;
	openLogin(): Promise<BgResponse<null>>;
}

/** État d'une analyse (texte ou photos) affiché par la section IA. */
export type ScanState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "done"; result: AnalysisResult }
	| { status: "error"; code: string };

export function createAiClient(send = sendToBackground): AiClient {
	return {
		access: () => send<ContentAccess>({ type: "content/access" }),
		scan: (scan) => send<AnalysisResult>({ type: "scan/run", scan }),
		openLogin: () => send<null>({ type: "ui/open-popup" }),
	};
}
