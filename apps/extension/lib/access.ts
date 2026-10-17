import type { Me } from "@radarnaque/shared";
import type { ContentAccess, ScanKind } from "./messages";

export type AccessFeature = "text" | "image" | "cards";

/** Fonctionnalité du plan (`Me.features`) qui ouvre chaque usage ; le texte est inclus partout. */
const REQUIRED_FEATURE: Record<AccessFeature, string | null> = {
	text: null,
	image: "image_scan",
	cards: "card_icons",
};

function remainingOf(me: Me, kind: ScanKind): number | null {
	return me.quotas.find((q) => q.scanKind === kind)?.remaining ?? null;
}

/** Droits de la page déduits de `GET /api/me`. Sans plan actif : `noSubscription`. */
export function accessOf(me: Me): ContentAccess {
	if (me.plan === null) return { status: "noSubscription" };
	return {
		status: "active",
		features: me.features,
		unlimited: me.unlimited,
		// Admin : aucun quota affiché, même si l'API en renvoie.
		remaining: me.unlimited
			? { text: null, image: null, total: null }
			: {
					text: remainingOf(me, "text"),
					image: remainingOf(me, "image"),
					total: me.totalCap?.remaining ?? null,
				},
	};
}

/**
 * Droit d'usage d'après le plan, sans tenir compte du quota restant : un quota
 * épuisé est signalé par le serveur (`402 quota_exhausted`). Un admin a droit à tout.
 */
export function canUse(access: ContentAccess, feature: AccessFeature): boolean {
	if (access.status !== "active") return false;
	if (access.unlimited) return true;
	const required = REQUIRED_FEATURE[feature];
	return required === null || access.features.includes(required);
}
