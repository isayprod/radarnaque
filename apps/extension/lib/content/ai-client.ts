import type { AnalysisResult, ScanProgressEvent } from "@radarnaque/shared";
import { browser } from "wxt/browser";
import {
	type BgResponse,
	type ContentAccess,
	type ScanRequest,
	sendToBackground,
} from "../messages";
import { type PortLike, type PortMessage, SCAN_PORT } from "../scan-port";
import type { ScanProgress } from "./scan-progress";

/** Une analyse lancée : son issue, et de quoi l'abandonner (navigation, démontage). */
export interface ScanHandle {
	/** Résout toujours, jamais en rejet ; `cancelled` après `cancel()`. */
	done: Promise<BgResponse<AnalysisResult>>;
	/** Ferme le port : le service worker annule la requête. Sans effet après la fin. */
	cancel(): void;
}

/**
 * Accès du content script aux analyses IA. Tout passe par le service worker, seul
 * face à l'API : le content script n'envoie que des messages de la liste blanche, et
 * l'analyse passe par le port `scan/stream`.
 */
export interface AiClient {
	access(): Promise<BgResponse<ContentAccess>>;
	scan(req: ScanRequest, onEvent: (e: ScanProgressEvent) => void): ScanHandle;
	openLogin(): Promise<BgResponse<null>>;
}

/** État de l'analyse IA affiché par la section IA, avec sa progression en direct. */
export type ScanState =
	| { status: "idle" }
	| { status: "loading"; progress: ScanProgress }
	| { status: "done"; result: AnalysisResult; progress: ScanProgress | null }
	| { status: "error"; code: string };

/** Ce que le log de debug « scan reçu » montre : le résultat (avec `debug`) ou le code d'erreur. */
export function scanOutcome(state: ScanState): unknown {
	if (state.status === "done") return state.result;
	if (state.status === "error") return { error: state.code };
	return state;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Message du service worker reconnu par sa forme ; null sinon (ignoré). Le service
 * worker a déjà validé et borné chaque événement : on ne revérifie que l'enveloppe.
 */
function portMessage(value: unknown): PortMessage | null {
	if (!isRecord(value)) return null;
	if (value.type === "event")
		return isRecord(value.event) ? (value as PortMessage) : null;
	if (value.type === "result")
		return isRecord(value.result) ? (value as PortMessage) : null;
	if (value.type === "error")
		return typeof value.code === "string" ? (value as PortMessage) : null;
	return null;
}

const failure = (code: string): BgResponse<never> => ({
	ok: false,
	error: { code },
});

const defaultConnect = (name: string): PortLike<ScanRequest> =>
	browser.runtime.connect({ name });

/**
 * Une analyse par port : le message de départ, puis chaque événement passé à `onEvent`,
 * jusqu'à une seule issue. Un port fermé sans issue (service worker arrêté, MV3) donne
 * `stream_interrupted` ; un service worker injoignable, `background_unavailable`.
 */
function scanByPort(
	connect: (name: string) => PortLike<ScanRequest>,
	req: ScanRequest,
	onEvent: (e: ScanProgressEvent) => void,
): ScanHandle {
	let settle!: (response: BgResponse<AnalysisResult>) => void;
	const done = new Promise<BgResponse<AnalysisResult>>((resolve) => {
		settle = resolve;
	});
	let over = false;
	/** Première issue seulement : rien n'est relayé ensuite. */
	const finish = (response: BgResponse<AnalysisResult>) => {
		if (over) return;
		over = true;
		settle(response);
	};

	let port: PortLike<ScanRequest>;
	try {
		port = connect(SCAN_PORT);
	} catch {
		finish(failure("background_unavailable"));
		return { done, cancel: () => {} };
	}
	const close = () => {
		try {
			port.disconnect();
		} catch {
			// Déjà fermé.
		}
	};

	port.onMessage.addListener((raw) => {
		if (over) return;
		const message = portMessage(raw);
		if (!message) return;
		if (message.type === "event") onEvent(message.event);
		else if (message.type === "result")
			finish({ ok: true, data: message.result });
		else finish(failure(message.code));
	});
	// Le service worker ferme le port après l'issue ; avant, c'est une interruption.
	port.onDisconnect.addListener(() => finish(failure("stream_interrupted")));
	try {
		port.postMessage(req);
	} catch {
		finish(failure("background_unavailable"));
		close();
	}
	return {
		done,
		cancel() {
			if (over) return;
			// `disconnect()` ne déclenche pas `onDisconnect` de ce côté : l'issue est posée ici.
			finish(failure("cancelled"));
			close();
		},
	};
}

export function createAiClient(
	connect: (name: string) => PortLike<ScanRequest> = defaultConnect,
	send: typeof sendToBackground = sendToBackground,
): AiClient {
	return {
		access: () => send<ContentAccess>({ type: "content/access" }),
		scan: (req, onEvent) => scanByPort(connect, req, onEvent),
		openLogin: () => send<null>({ type: "ui/open-popup" }),
	};
}
