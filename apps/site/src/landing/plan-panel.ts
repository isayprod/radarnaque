/**
 * Panneau d'une formule de la landing, partagé par le rendu au build (`render.ts`)
 * et le script de la page (`main.ts`, offre en cours). Module à part, qui n'importe
 * que le nécessaire : le script de la landing ne charge ni la mise en page, ni la
 * maquette, ni les textes de confidentialité.
 */
import type { Locale } from "@radarnaque/shared";
import { h, type VNode } from "../h.ts";
import type { Offer, OfferPlan } from "../offer.ts";
import { formatCents, type PlanText, PRICING } from "../pages-i18n.ts";
import { featureLines } from "../plan-lines.ts";
import { LANDING_TEXT } from "./i18n.ts";

/** Attributs d'un bloc qui apparaît au scroll, au rang `i` parmi ses voisins. */
export const reveal = (i: number) => ({
	"data-reveal": true,
	style: `--i:${i}`,
});

/** Champs des lignes d'une formule, dans l'ordre de `featureLines`. */
const LINE_FIELDS = ["scans", "photos", "button", "icons"] as const;

/** Panneau d'une formule ; chaque valeur porte `data-field` (remplie par l'offre en cours, `main.ts`). */
export function planPanelNode(
	locale: Locale,
	key: keyof Offer,
	plan: OfferPlan,
	rank = 0,
): VNode {
	const t = LANDING_TEXT[locale];
	const text: PlanText = PRICING[locale].plans[key];
	const trial = key === "trial";
	// L'essai affiche « 0 € » ; un plan payant sans prix n'affiche rien (jamais « undefined »).
	const price =
		trial || plan.monthlyCents !== null
			? formatCents(plan.monthlyCents ?? 0, locale)
			: "";
	const lines = featureLines(
		text,
		plan,
		locale,
		trial ? "scansTotal" : "scansMonth",
	);
	return h(
		"article",
		{
			class:
				key === "standard"
					? "landing-plan landing-plan--featured"
					: "landing-plan",
			"data-plan": key,
			...reveal(rank),
		},
		h(
			"div",
			{ class: "landing-plan__head" },
			h("h3", { "data-field": "name" }, text.name),
			trial && h("span", { class: "landing-badge" }, t.freeBadge),
		),
		h(
			"p",
			{ class: "landing-plan__price" },
			h("span", { "data-field": "price" }, price),
			!trial &&
				price !== "" &&
				h("small", { "data-field": "period" }, ` ${t.perMonth}`),
		),
		h(
			"p",
			{ class: "landing-plan__tagline", "data-field": "tagline" },
			text.tagline,
		),
		h(
			"ul",
			{ class: "landing-plan__lines", "data-field": "features" },
			lines.map((line, i) => h("li", { "data-field": LINE_FIELDS[i] }, line)),
		),
	);
}
