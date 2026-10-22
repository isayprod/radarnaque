/**
 * Doublure de `lib/messages` pour la galerie de la popup : `sendToBackground`
 * répond selon le scénario de l'adresse (`scenario.ts`), sans service worker ni
 * réseau. Les types restent ceux du vrai module.
 */
import type { Me } from "@radarnaque/shared";
import type { BgRequest, BgResponse } from "../../lib/messages";
import { DEMO_EMAIL, SCENARIO } from "./scenario";

export type {
	AuthState,
	BgRequest,
	BgResponse,
	ContentAccess,
} from "../../lib/messages";

const LIMITED: Me = {
	userId: "galerie-1",
	email: DEMO_EMAIL,
	role: "user",
	plan: "standard",
	features: ["card_icons"],
	unlimited: false,
	maxImages: 6,
	periodStart: null,
	quotas: [{ scanKind: "full", limit: 30, used: 12, remaining: 18 }],
	totalCap: null,
};

const UNLIMITED: Me = {
	...LIMITED,
	role: "admin",
	plan: null,
	unlimited: true,
	quotas: [],
};

const ok = <T>(data: T): BgResponse<T> => ({ ok: true, data });
const fail = <T>(code: string): BgResponse<T> => ({
	ok: false,
	error: { code },
});

/** Petite attente : les états « en cours » (envoi, vérification) restent visibles. */
const later = <T>(value: T, ms = 400) =>
	new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function authState(): BgResponse<unknown> {
	switch (SCENARIO.state) {
		case "signedIn":
			return ok({ status: "signedIn", me: LIMITED });
		case "unlimited":
			return ok({ status: "signedIn", me: UNLIMITED });
		case "unavailable":
			return fail("background_unavailable");
		default:
			return ok({ status: "signedOut" });
	}
}

export async function sendToBackground<T>(
	req: BgRequest,
): Promise<BgResponse<T>> {
	switch (req.type) {
		case "auth/state":
			// Chargement : la réponse n'arrive jamais, le squelette reste affiché.
			if (SCENARIO.state === "loading") return new Promise(() => {});
			return authState() as BgResponse<T>;
		case "auth/start":
		case "auth/sign-out":
			return later(ok(null) as BgResponse<T>);
		case "auth/verify-otp":
			// Tout code est refusé : l'écran du code montre son message d'erreur.
			return later(fail<T>("invalid_otp"));
		case "account/delete":
			return later(fail<T>("network"));
		default:
			return fail<T>("unexpected");
	}
}
