import type { Locale } from "@radarnaque/shared";
import { toDom } from "./h";
import { footerNode, navNode, type SitePage } from "./layout";
import type { Offer, OfferPlan } from "./offer";
import {
	fill,
	formatCents,
	PLANS,
	type PlanText,
	PRICING,
	PRIVACY,
	PRIVACY_EMAIL,
	PRIVACY_ORDER,
	PRIVACY_RETENTION_MONTHS,
} from "./pages-i18n";
import { featureLines } from "./plan-lines";

// All text goes through textContent / text nodes, never innerHTML.

function el<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	text?: string,
	className?: string,
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (text !== undefined) node.textContent = text;
	if (className) node.className = className;
	return node;
}

/**
 * Remplace le contenu de `root` par la navigation partagée, le contenu de la page
 * dans `<main>` et le pied de page partagé (rendus par `toDom`).
 */
function layout(
	doc: Document,
	root: HTMLElement,
	locale: Locale,
	page: SitePage,
	main: HTMLElement,
): void {
	const header = el(doc, "header", undefined, "site-header");
	header.append(toDom(doc, navNode(locale, page)));
	root.replaceChildren(header, main, toDom(doc, footerNode(locale)));
}

function planCard(
	doc: Document,
	key: keyof Offer,
	text: PlanText,
	lines: string[],
	priceLines: string[],
): HTMLElement {
	// Standard est mis en avant (spec landing §3.6).
	const card = el(
		doc,
		"article",
		undefined,
		key === "standard" ? "plan plan--featured" : "plan",
	);
	card.dataset.plan = key;
	card.append(el(doc, "h2", text.name), el(doc, "p", text.tagline, "tagline"));
	const prices = el(doc, "div", undefined, "prices");
	for (const line of priceLines) prices.append(el(doc, "p", line, "price"));
	const ul = el(doc, "ul");
	for (const line of lines) ul.append(el(doc, "li", line));
	card.append(prices, ul);
	return card;
}

export function renderPricing(
	doc: Document,
	root: HTMLElement,
	locale: Locale,
	offer: Offer = PLANS,
): void {
	const t = PRICING[locale];
	const { standard, premium, trial } = offer;
	doc.documentElement.lang = locale;
	doc.title = `${t.title} – Radarnaque`;

	// Un prix absent n'est pas affiché ; la mention TVA suit seulement s'il y a un prix.
	const priceLines = (plan: OfferPlan) => {
		const lines: string[] = [];
		if (plan.monthlyCents !== null) {
			lines.push(
				fill(t.perMonth, { price: formatCents(plan.monthlyCents, locale) }),
			);
		}
		if (plan.yearlyCents !== null) {
			lines.push(
				fill(t.perYear, { price: formatCents(plan.yearlyCents, locale) }),
			);
		}
		if (lines.length > 0) lines.push(t.vatIncluded);
		return lines;
	};

	const plans = el(doc, "div", undefined, "plans");
	plans.append(
		planCard(
			doc,
			"trial",
			t.plans.trial,
			featureLines(t.plans.trial, trial, locale, "scansTotal"),
			[t.free],
		),
		planCard(
			doc,
			"standard",
			t.plans.standard,
			featureLines(t.plans.standard, standard, locale, "scansMonth"),
			priceLines(standard),
		),
		planCard(
			doc,
			"premium",
			t.plans.premium,
			featureLines(t.plans.premium, premium, locale, "scansMonth"),
			priceLines(premium),
		),
	);

	const main = el(doc, "main", undefined, "page-main");
	main.append(
		el(doc, "h1", t.title),
		el(doc, "p", t.intro, "intro"),
		plans,
		el(doc, "p", t.paymentSoon, "soon"),
	);
	layout(doc, root, locale, "pricing", main);
}

function bodyWithEmail(doc: Document, template: string): HTMLElement {
	const p = el(doc, "p");
	const filled = fill(template, { months: PRIVACY_RETENTION_MONTHS });
	const parts = filled.split("{email}");
	parts.forEach((part, i) => {
		if (i > 0) {
			const a = el(doc, "a", PRIVACY_EMAIL);
			a.setAttribute("href", `mailto:${PRIVACY_EMAIL}`);
			p.append(a);
		}
		p.append(doc.createTextNode(part));
	});
	return p;
}

export function renderPrivacy(
	doc: Document,
	root: HTMLElement,
	locale: Locale,
): void {
	const t = PRIVACY[locale];
	doc.documentElement.lang = locale;
	doc.title = `${t.title} – Radarnaque`;

	// Largeur de lecture de 45 à 70 caractères (pages.css).
	const main = el(doc, "main", undefined, "page-main page-main--prose");
	main.append(
		el(doc, "h1", t.title),
		el(doc, "p", t.intro, "intro"),
		...PRIVACY_ORDER.map((key) => {
			const section = el(doc, "section");
			section.append(
				el(doc, "h2", t.sections[key].heading),
				bodyWithEmail(doc, t.sections[key].body),
			);
			return section;
		}),
	);
	layout(doc, root, locale, "privacy", main);
}
