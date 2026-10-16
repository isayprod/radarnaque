import type { Locale, Me } from "@radarnaque/shared";
import { browser } from "wxt/browser";

export type BgRequest =
	| { type: "auth/start"; email: string; locale: Locale }
	| { type: "auth/verify-otp"; email: string; otp: string }
	| { type: "auth/state" }
	| { type: "auth/sign-out" };

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
