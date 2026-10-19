import type { Me } from "@radarnaque/shared";
import type { ContentAccess } from "./messages";

/** `ai` : l'analyse IA (`full`) ; `cards` : les icônes des cartes de la liste. */
export type AccessFeature = "ai" | "cards";

/** Fonctionnalité du plan (`Me.features`) qui ouvre chaque usage ; l'analyse IA est incluse partout. */
const REQUIRED_FEATURE: Record<AccessFeature, string | null> = {
	ai: null,
	cards: "card_icons",
};

/**
 * Scans restants : le quota `full`, limité par le plafond total ; `null` si le plan
 * n'a ni l'un ni l'autre.
 */
function remainingScans(me: Me): number | null {
	const limits = [
		me.quotas.find((q) => q.scanKind === "full")?.remaining,
		me.totalCap?.remaining,
	].filter((n): n is number => typeof n === "number");
	return limits.length > 0 ? Math.min(...limits) : null;
}

/**
 * Droits de la page déduits de `GET /api/me`. Sans plan actif : `noSubscription`, sauf
 * pour un admin (`unlimited`), que le serveur laisse scanner même sans abonnement.
 * Le superuser de développement (vu en Premium par l'API) est illimité comme un admin
 * et a en plus `debug` ; l'API ne renvoie ce rôle que hors production (sinon `user`).
 */
export function accessOf(me: Me): ContentAccess {
	const superuser = me.role === "superuser";
	const unlimited = me.unlimited || superuser;
	if (me.plan === null && !unlimited) return { status: "noSubscription" };
	return {
		status: "active",
		features: me.features,
		unlimited,
		debug: superuser,
		maxImages: me.maxImages,
		// Admin ou superuser : aucun quota affiché, même si l'API en renvoie.
		remaining: { scans: unlimited ? null : remainingScans(me) },
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

/** Logs et affichage de debug : uniquement pour un accès actif de superuser. */
export function isDebug(access: ContentAccess): boolean {
	return access.status === "active" && access.debug;
}
