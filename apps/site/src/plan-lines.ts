/**
 * Lignes d'une formule (quota, photos, bouton, icônes), partagées par `/pricing`
 * (rendu dans la page) et la landing (rendu au build) : une seule source de règles.
 */
import type { Locale } from "@radarnaque/shared";
import type { OfferPlan } from "./offer.ts";
import { fill, formatInt, type PlanText } from "./pages-i18n.ts";

/** Lignes d'une carte : quota, photos, bouton, puis icônes seulement si le plan les a. */
export function featureLines(
	text: PlanText,
	plan: OfferPlan,
	locale: Locale,
	quota: "scansTotal" | "scansMonth",
): string[] {
	const f = text.features;
	const photos =
		plan.maxImages === 0
			? f.photosNone
			: plan.maxImages === 1
				? f.photosOne
				: fill(f.photosMany, { photos: formatInt(plan.maxImages, locale) });
	const lines = [
		fill(f[quota] ?? "", { scans: formatInt(plan.scans, locale) }),
		photos,
		f.button,
	];
	if (plan.cardIcons) lines.push(f.icons);
	return lines;
}
