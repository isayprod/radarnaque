import type { Locale } from "@radarnaque/shared";
import {
	fill,
	formatCents,
	formatInt,
	PLANS,
	type PlanText,
	PRICING,
	PRIVACY,
	PRIVACY_EMAIL,
	PRIVACY_ORDER,
	PRIVACY_RETENTION_MONTHS,
} from "./pages-i18n";

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

function langSwitch(doc: Document, locale: Locale, label: string): HTMLElement {
	const other: Locale = locale === "fr" ? "nl" : "fr";
	const nav = el(doc, "nav", undefined, "lang");
	const a = el(doc, "a", label);
	a.setAttribute("href", `?lang=${other}`);
	a.setAttribute("hreflang", other);
	a.setAttribute("lang", other);
	a.dataset.langSwitch = "";
	nav.append(a);
	return nav;
}

function planCard(
	doc: Document,
	text: PlanText,
	vars: Record<string, string | number>,
	priceLines: string[],
): HTMLElement {
	const card = el(doc, "article", undefined, "plan");
	card.append(el(doc, "h2", text.name), el(doc, "p", text.tagline, "tagline"));
	for (const line of priceLines) card.append(el(doc, "p", line, "price"));
	const ul = el(doc, "ul");
	for (const tpl of Object.values(text.features)) {
		ul.append(el(doc, "li", fill(tpl, vars)));
	}
	card.append(ul);
	return card;
}

export function renderPricing(
	doc: Document,
	root: HTMLElement,
	locale: Locale,
): void {
	const t = PRICING[locale];
	const { standard, premium, trial } = PLANS;
	doc.documentElement.lang = locale;
	doc.title = `${t.title} – Radarnaque`;

	const priceLines = (monthly: number, yearly: number) => [
		fill(t.perMonth, { price: formatCents(monthly, locale) }),
		fill(t.perYear, { price: formatCents(yearly, locale) }),
		t.vatIncluded,
	];

	const plans = el(doc, "div", undefined, "plans");
	plans.append(
		planCard(doc, t.plans.trial, { scans: formatInt(trial.scans, locale) }, [
			t.free,
		]),
		planCard(
			doc,
			t.plans.standard,
			{ texts: formatInt(standard.textPerMonth, locale) },
			priceLines(standard.monthlyCents, standard.yearlyCents),
		),
		planCard(
			doc,
			t.plans.premium,
			{
				texts: formatInt(premium.textPerMonth, locale),
				photos: formatInt(premium.photoPerMonth, locale),
			},
			priceLines(premium.monthlyCents, premium.yearlyCents),
		),
	);

	const privacy = el(doc, "a", t.privacyLink);
	privacy.setAttribute("href", `/privacy/?lang=${locale}`);
	const footer = el(doc, "p", undefined, "footer");
	footer.append(privacy);

	root.replaceChildren(
		langSwitch(doc, locale, t.switchLang),
		el(doc, "h1", t.title),
		el(doc, "p", t.intro),
		plans,
		el(doc, "p", t.paymentSoon, "soon"),
		footer,
	);
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

	const pricing = el(doc, "a", t.backToPricing);
	pricing.setAttribute("href", `/pricing/?lang=${locale}`);
	const footer = el(doc, "p", undefined, "footer");
	footer.append(pricing);

	root.replaceChildren(
		langSwitch(doc, locale, t.switchLang),
		el(doc, "h1", t.title),
		el(doc, "p", t.intro),
		...PRIVACY_ORDER.map((key) => {
			const section = el(doc, "section");
			section.append(
				el(doc, "h2", t.sections[key].heading),
				bodyWithEmail(doc, t.sections[key].body),
			);
			return section;
		}),
		footer,
	);
}
