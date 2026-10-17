import type { Locale, Me } from "@radarnaque/shared";
import { browser } from "wxt/browser";
import type { Listing } from "./listing/types";
import type { Signal } from "./rules/rules";

export type ScanKind = "text" | "image";
export type ScanTrigger = "button" | "card";

/** Demande de scan envoyée par le content script au service worker. */
export interface ScanRequest {
	/** Complète, identité du vendeur comprise : le service worker la retire avant l'API. */
	listing: Listing;
	signals: Signal[];
	rulesVersion: number;
	scanKind: ScanKind;
	trigger: ScanTrigger;
	partial: boolean;
}

/**
 * Droits de la page pour le content script. `remaining.*` vaut `null` sans plafond
 * (admin, ou quota absent du plan) : on n'affiche jamais « 0 » dans ce cas.
 */
export type ContentAccess =
	| { status: "signedOut" }
	| { status: "noSubscription" }
	| {
			status: "active";
			features: string[];
			unlimited: boolean;
			remaining: {
				text: number | null;
				image: number | null;
				total: number | null;
			};
	  };

export type BgRequest =
	| { type: "auth/start"; email: string; locale: Locale }
	| { type: "auth/verify-otp"; email: string; otp: string }
	| { type: "auth/state" }
	| { type: "auth/sign-out" }
	| { type: "content/access" }
	| { type: "scan/run"; scan: ScanRequest }
	| { type: "ui/open-popup" };

/** Seuls messages qu'un content script peut envoyer : jamais `auth/*`. */
export const CONTENT_SCRIPT_MESSAGES: ReadonlySet<BgRequest["type"]> = new Set<
	BgRequest["type"]
>(["content/access", "scan/run", "ui/open-popup"]);

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
