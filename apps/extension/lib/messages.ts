import type { Locale, Me } from "@radarnaque/shared";
import { browser } from "wxt/browser";
import type { Listing } from "./listing/types";
import type { Signal } from "./rules/rules";

export type ScanTrigger = "button" | "card";

/**
 * Demande de scan : le message de départ du port `scan/stream`, du content script au
 * service worker. Le serveur fait toujours une analyse `full` (photos et recherche web).
 */
export interface ScanRequest {
	/** Complète, identité du vendeur comprise : le service worker la retire avant l'API. */
	listing: Listing;
	signals: Signal[];
	rulesVersion: number;
	trigger: ScanTrigger;
	partial: boolean;
	/** Superuser hors production : relance sans cache. Ignoré par le serveur pour les autres. */
	noCache?: boolean;
}

/**
 * Droits de la page pour le content script. `remaining.scans` vaut `null` sans plafond
 * (admin, superuser, ou quota absent du plan) : on n'affiche jamais « 0 » dans ce cas.
 * `maxImages` : photos envoyées au plus par analyse, selon le plan. `debug` n'est vrai
 * que pour le superuser de développement (rôle renvoyé par `/api/me`) ; les autres
 * états n'en ont pas et valent `false` (voir `isDebug`).
 */
export type ContentAccess =
	| { status: "signedOut" }
	| { status: "noSubscription" }
	| {
			status: "active";
			features: string[];
			unlimited: boolean;
			debug: boolean;
			maxImages: number;
			remaining: { scans: number | null };
	  };

export type BgRequest =
	| { type: "auth/start"; email: string; locale: Locale }
	| { type: "auth/verify-otp"; email: string; otp: string }
	| { type: "auth/state" }
	| { type: "auth/sign-out" }
	| { type: "content/access" }
	/** Superuser : drapeau des logs de debug de la page, sans appel réseau hors session. */
	| { type: "content/debug" }
	| { type: "ui/open-popup" };

/**
 * Seuls messages qu'un content script peut envoyer : jamais `auth/*`. Le scan passe par
 * le port `scan/stream` (`SCAN_PORT`), soumis au même contrôle de l'émetteur.
 */
export const CONTENT_SCRIPT_MESSAGES: ReadonlySet<BgRequest["type"]> = new Set<
	BgRequest["type"]
>(["content/access", "content/debug", "ui/open-popup"]);

export type BgResponse<T> =
	| { ok: true; data: T }
	| { ok: false; error: { code: string } };

export type AuthState =
	| { status: "signedOut" }
	| { status: "signedIn"; me: Me };

/** Envoie une requête au service worker. */
export async function sendToBackground<T>(
	req: BgRequest,
): Promise<BgResponse<T>> {
	try {
		const response = (await browser.runtime.sendMessage(req)) as
			| BgResponse<T>
			| undefined;
		return response ?? { ok: false, error: { code: "background_unavailable" } };
	} catch {
		return { ok: false, error: { code: "background_unavailable" } };
	}
}
