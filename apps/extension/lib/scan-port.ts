import type { ScanProgressEvent } from "@radarnaque/shared";
import type { ApiClient } from "./api-client";
import { errorCode, type InternalSender } from "./background-handlers";
import type { ScanDebugHooks } from "./debug-state";
import type { ScanRequest } from "./messages";
import { parseStreamMessage, type StreamOutcome } from "./scan-events";
import { toScanIn } from "./scan-payload";
import type { SseMessage } from "./sse";

/** Nom du port d'une analyse : `browser.runtime.connect({ name: SCAN_PORT })` (spec §10.1). */
export const SCAN_PORT = "scan/stream";

/** Au-delà, sans fin de flux, la requête est annulée et l'onglet reçoit `timeout`. */
export const SCAN_TIMEOUT_MS = 200_000;

/** Message posté à l'onglet : une progression, puis une seule fin (`result` ou `error`). */
export type PortMessage =
	| { type: "event"; event: ScanProgressEvent }
	| StreamOutcome;

/** Partie de `runtime.Port` utilisée ; un faux dans les tests. */
export interface PortLike {
	name: string;
	sender?: InternalSender;
	postMessage(message: PortMessage): void;
	disconnect(): void;
	onMessage: { addListener(fn: (message: unknown) => void): void };
	onDisconnect: { addListener(fn: () => void): void };
}

export interface ScanPortDeps {
	api: Pick<ApiClient, "scanStream">;
	/** Contrôle de l'émetteur, le même que pour les messages (`portSenderGuard`). */
	allowSender: (sender: InternalSender | undefined) => boolean;
	/** Debug du superuser : l'état partagé avec `createHandlers` (R3, R5). */
	debug: ScanDebugHooks;
	timeoutMs?: number;
}

/**
 * Listener de `runtime.onConnect` : une analyse par port. L'onglet envoie un seul message
 * de départ (`ScanRequest`) ; le service worker relaie chaque événement validé, puis poste
 * une seule fin et ferme le port. Un autre nom de port ou un émetteur refusé : fermé
 * aussitôt, sans aucun appel. L'onglet qui ferme le port annule la requête.
 */
export function createScanPortListener(
	deps: ScanPortDeps,
): (port: PortLike) => void {
	const { api, debug } = deps;
	const timeoutMs = deps.timeoutMs ?? SCAN_TIMEOUT_MS;

	return (port) => {
		if (port.name !== SCAN_PORT || !deps.allowSender(port.sender)) {
			port.disconnect();
			return;
		}
		const controller = new AbortController();
		let started = false;
		/** Fin postée, délai dépassé ou port fermé par l'onglet : plus rien n'est posté. */
		let over = false;
		// Le délai court dès l'ouverture du port, aussi sans message de départ. Les deux
		// appels sont synchrones : la lecture annulée trouve `over` et ne poste plus rien.
		const timer = setTimeout(() => {
			controller.abort();
			finish({ type: "error", code: "timeout" });
			void debug.group("scan en erreur", { code: "timeout" });
		}, timeoutMs);

		function post(message: PortMessage): void {
			if (over) return;
			try {
				port.postMessage(message);
			} catch {
				// Port déjà fermé côté onglet : son `onDisconnect` suit.
			}
		}

		/** Poste la fin (au plus une) et ferme le port. */
		function finish(outcome: StreamOutcome | null): void {
			if (over) return;
			if (outcome) post(outcome);
			over = true;
			clearTimeout(timer);
			try {
				port.disconnect();
			} catch {
				// Déjà fermé.
			}
		}

		async function failed(code: string): Promise<StreamOutcome> {
			// Le code seul : jamais le message ni les détails de l'erreur.
			await debug.group("scan en erreur", { code });
			return { type: "error", code };
		}

		/** L'analyse, du message de départ à sa fin ; `null` si elle est déjà terminée. */
		async function relay(message: unknown): Promise<StreamOutcome | null> {
			await debug.ensureKnown();
			// La demande vient d'une page web : sa forme est vérifiée avant `toScanIn`, qui
			// retire l'identité du vendeur et applique les bornes.
			const listing = (message as { listing?: unknown } | null)?.listing;
			if (
				typeof message !== "object" ||
				typeof listing !== "object" ||
				!listing
			) {
				return failed("invalid_listing");
			}
			let stream: AsyncIterable<SseMessage>;
			try {
				const body = toScanIn(message as ScanRequest);
				await debug.group("scan envoyé", body);
				stream = await api.scanStream(body, controller.signal);
			} catch (error) {
				// Même code que l'ancien `scan/run` (refus de l'API, session, réseau).
				return over ? null : failed(errorCode(error));
			}
			try {
				for await (const m of stream) {
					if (over) return null;
					const parsed = parseStreamMessage(m);
					if (parsed === null) continue;
					if (parsed.type === "result") {
						await debug.group("scan reçu", {
							outcome: "ok",
							result: parsed.result,
						});
						return parsed;
					}
					if (parsed.type === "error") return failed(parsed.code);
					await debug.group("scan événement", parsed);
					post({ type: "event", event: parsed });
				}
			} catch {
				// Lecture coupée (réseau, ou annulation après la fin).
			}
			return over ? null : failed("stream_interrupted");
		}

		port.onDisconnect.addListener(() => {
			// L'onglet a fermé le port (navigation, onglet fermé) : la requête est annulée.
			over = true;
			clearTimeout(timer);
			controller.abort();
		});
		port.onMessage.addListener((message) => {
			if (started || over) return;
			started = true;
			void relay(message).then(finish, (error: unknown) =>
				finish({ type: "error", code: errorCode(error) }),
			);
		});
	};
}
