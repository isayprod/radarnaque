/**
 * Corps de la landing (spec landing §3), rendu au build par le plugin Vite : tout
 * le texte est dans le HTML (moteurs, aperçus de liens, navigateurs sans
 * JavaScript). Construit avec `h`, rendu par `toHtml` (texte et attributs échappés).
 *
 * Les blocs qui apparaissent au scroll portent `data-reveal` et leur rang
 * `style="--i:n"` (écart de 60 ms) ; le hero n'en porte jamais. Le calque `.sky`
 * et le script de la page (`main.ts`, chargé par les gabarits `index.html`) les
 * animent ; sans JavaScript, tout reste visible.
 */
import type { Locale } from "@radarnaque/shared";
import { type AttrValue, type Child, h, toHtml, type VNode } from "../h.ts";
import { footerNode, logoNode, navNode, SOURCE_CODE_URL } from "../layout.ts";
import type { Offer, OfferPlan } from "../offer.ts";
import { formatCents, type PlanText, PRICING } from "../pages-i18n.ts";
import { featureLines } from "../plan-lines.ts";
import { LANDING_TEXT } from "./i18n.ts";
import { mockupNode } from "./mockup.ts";

export interface LandingOptions {
	/** Offre affichée dans les formules (au build : `PLANS`, l'offre de secours). */
	offer: Offer;
	/** Lien du Chrome Web Store ; `null` : « Bientôt disponible », sans lien. */
	storeUrl: string | null;
}

/** Attributs d'un bloc qui apparaît au scroll, au rang `i` parmi ses voisins. */
const reveal = (i: number) => ({ "data-reveal": true, style: `--i:${i}` });

/**
 * Pilule blanche d'installation (hero et section d'installation). Sans lien du
 * store, elle n'est pas un lien : « Bientôt disponible », `aria-disabled`.
 */
function installPill(
	locale: Locale,
	storeUrl: string | null,
	attrs: Record<string, AttrValue> = {},
): VNode {
	const t = LANDING_TEXT[locale];
	const logo = logoNode({ size: 18 });
	if (storeUrl)
		return h(
			"a",
			{ ...attrs, class: "landing-pill", href: storeUrl, "data-install": true },
			logo,
			h("span", {}, t.install),
		);
	return h(
		"span",
		{
			...attrs,
			class: "landing-pill landing-pill--soon",
			role: "link",
			"aria-disabled": "true",
			"data-install": true,
		},
		logo,
		h("span", {}, t.installSoon),
	);
}

function hero(locale: Locale, storeUrl: string | null): VNode {
	const t = LANDING_TEXT[locale];
	return h(
		"header",
		{ class: "landing-hero" },
		navNode(locale, "home"),
		h(
			"div",
			{ class: "landing-hero__inner" },
			h("h1", { class: "landing-hero__title" }, t.heroTitle),
			h("p", { class: "landing-hero__tagline" }, t.heroTagline),
			h("p", { class: "landing-hero__note" }, t.heroNote),
			h("div", { class: "landing-hero__cta" }, installPill(locale, storeUrl)),
		),
	);
}

function benefits(locale: Locale): VNode {
	return h(
		"ul",
		{ class: "landing-benefits" },
		LANDING_TEXT[locale].benefits.map((text, i) => h("li", reveal(i), text)),
	);
}

/** Étiquette et titre d'une section, premiers blocs à apparaître. */
function sectionHead(label: string, title: string, id: string): VNode[] {
	return [
		h("p", { class: "landing-label", ...reveal(0) }, label),
		h("h2", { class: "landing-title", id, ...reveal(1) }, title),
	];
}

/** Pilules des étapes 2 et 3 : l'allure du bouton et de la pastille de l'extension. */
function stepVisual(locale: Locale, step: number): Child {
	const t = LANDING_TEXT[locale];
	if (step === 1)
		return h(
			"p",
			{ class: "landing-step__visual" },
			h(
				"span",
				{ class: "landing-chip" },
				logoNode({ size: 16 }),
				h("span", {}, t.stepAnalyze),
			),
		);
	if (step === 2)
		return h(
			"p",
			{ class: "landing-step__visual" },
			h(
				"span",
				{ class: "landing-chip" },
				h("span", { class: "landing-chip__dot", "aria-hidden": "true" }),
				h("span", {}, t.stepLevel),
				// Filet de 1 px à l'écran ; « · » lu sans CSS et par les lecteurs d'écran.
				h("span", { class: "landing-chip__sep" }, " · "),
				h("span", { class: "landing-chip__score" }, t.stepScore),
			),
		);
	return null;
}

function howItWorks(locale: Locale): VNode {
	const t = LANDING_TEXT[locale];
	return h(
		"section",
		{
			id: "comment",
			class: "landing-section",
			"aria-labelledby": "comment-titre",
		},
		sectionHead(t.howLabel, t.howTitle, "comment-titre"),
		h(
			"ol",
			{ class: "landing-steps" },
			t.steps.map((step, i) =>
				h(
					"li",
					{ class: "landing-step", ...reveal(i) },
					h(
						"span",
						{ class: "landing-step__num", "aria-hidden": "true" },
						String(i + 1),
					),
					h("h3", {}, step.title),
					h("p", {}, step.body),
					stepVisual(locale, i),
				),
			),
		),
	);
}

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

function plans(locale: Locale, offer: Offer): VNode {
	const t = LANDING_TEXT[locale];
	return h(
		"section",
		{
			id: "formules",
			class: "landing-section",
			"aria-labelledby": "formules-titre",
		},
		sectionHead(t.plansLabel, t.plansTitle, "formules-titre"),
		h("p", { class: "landing-lead", ...reveal(2) }, t.plansLead),
		h(
			"div",
			{ class: "landing-plans" },
			planPanelNode(locale, "trial", offer.trial, 0),
			planPanelNode(locale, "standard", offer.standard, 1),
			planPanelNode(locale, "premium", offer.premium, 2),
		),
		h(
			"p",
			{ class: "landing-plans__note", ...reveal(3) },
			`${t.paymentSoon} `,
			h("a", { href: `/pricing/?lang=${locale}` }, t.plansDetail),
		),
	);
}

function install(locale: Locale, storeUrl: string | null): VNode {
	const t = LANDING_TEXT[locale];
	return h(
		"section",
		{ class: "landing-install", "aria-labelledby": "installation-titre" },
		h(
			"h2",
			{ class: "landing-title", id: "installation-titre", ...reveal(0) },
			t.installTitle,
		),
		installPill(locale, storeUrl, reveal(1)),
		h(
			"p",
			{ class: "landing-install__links", ...reveal(2) },
			`${t.browsers} · `,
			h("a", { href: `/privacy/?lang=${locale}` }, t.privacyPolicy),
			" · ",
			h("a", { href: SOURCE_CODE_URL }, t.sourceCode),
		),
	);
}

/** Arbre du corps de la landing. */
export function landingNodes(locale: Locale, options: LandingOptions): VNode[] {
	const { offer, storeUrl } = options;
	return [
		// Calque fixe du dégradé qui suit le scroll (spec landing §5.1), derrière la page.
		h("div", { class: "sky", "aria-hidden": "true" }),
		hero(locale, storeUrl),
		// Maquette du produit (spec landing §4), à cheval sur le bas du hero. Dans un
		// repère `complementary` (tout le contenu de la page est dans un repère) ; son
		// nom reste celui de l'illustration (`role="img"` et sa description).
		h(
			"aside",
			{ class: "landing-mockup", "data-mockup": true },
			mockupNode(locale),
		),
		h(
			"main",
			{ class: "landing-main" },
			benefits(locale),
			howItWorks(locale),
			plans(locale, offer),
			install(locale, storeUrl),
		),
		footerNode(locale),
	];
}

/** HTML du corps de la landing, texte et attributs échappés. */
export function renderLanding(locale: Locale, options: LandingOptions): string {
	return landingNodes(locale, options).map(toHtml).join("\n");
}
