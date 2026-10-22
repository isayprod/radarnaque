/**
 * Mise en page partagée du site (spec landing §3.1 et §3.8) : logo, navigation et
 * pied de page, construits avec `h` et rendus à l'identique au build (landing,
 * `toHtml`) et dans la page (`/pricing`, `/privacy`, `toDom`).
 */
import type { Locale } from "@radarnaque/shared";
import { h, type VNode } from "./h.ts";
import { logoNode } from "./logo-node.ts";
import { fill, PRIVACY_EMAIL, PRIVACY_RETENTION_MONTHS } from "./pages-i18n.ts";

export { logoNode };

export const SOURCE_CODE_URL = "https://github.com/isayprod/radarnaque";

export interface LayoutText {
	/** Nom accessible de la navigation principale. */
	navLabel: string;
	howItWorks: string;
	plans: string;
	privacy: string;
	/** Texte visible du lien de langue : code de l'autre langue. */
	langCode: string;
	/** Nom accessible du lien de langue (contient `langCode`). */
	langLabel: string;
	/** Placeholder : {months}. */
	footerData: string;
	sourceCode: string;
	contact: string;
}

export const LAYOUT_TEXT: Record<Locale, LayoutText> = {
	fr: {
		navLabel: "Navigation principale",
		howItWorks: "Comment ça marche",
		plans: "Formules",
		privacy: "Confidentialité",
		langCode: "NL",
		langLabel: "Nederlands (NL)",
		footerData:
			"Radarnaque ne lit que la page de l'annonce que vous analysez, au moment où vous cliquez. Les analyses sont conservées {months} mois puis effacées ; vous pouvez supprimer votre compte à tout moment depuis l'extension.",
		sourceCode: "Code source",
		contact: "Contact",
	},
	nl: {
		navLabel: "Hoofdnavigatie",
		howItWorks: "Hoe het werkt",
		plans: "Formules",
		privacy: "Privacy",
		langCode: "FR",
		langLabel: "Français (FR)",
		footerData:
			"Radarnaque leest alleen de pagina van de advertentie die je analyseert, op het moment dat je klikt. Analyses worden {months} maanden bewaard en daarna gewist; je kunt je account op elk moment verwijderen via de extensie.",
		sourceCode: "Broncode",
		contact: "Contact",
	},
};

/** Accueil de chaque langue : FR sur `/`, NL sur `/nl/`. */
const HOME: Record<Locale, string> = { fr: "/", nl: "/nl/" };

export type SitePage = "home" | "pricing" | "privacy";

/**
 * Navigation : logo et « Radarnaque » (vers l'accueil de la langue), « Comment ça
 * marche » et « Formules » (ancres sur l'accueil, accueil + ancre ailleurs),
 * « Confidentialité », et le lien vers la même page dans l'autre langue.
 */
export function navNode(locale: Locale, page: SitePage): VNode {
	const t = LAYOUT_TEXT[locale];
	const other: Locale = locale === "fr" ? "nl" : "fr";
	const anchor = (id: string) =>
		page === "home" ? `#${id}` : `${HOME[locale]}#${id}`;
	const langHref = page === "home" ? HOME[other] : `/${page}/?lang=${other}`;
	return h(
		"nav",
		{ class: "site-nav", "aria-label": t.navLabel },
		h(
			"a",
			{ class: "site-nav__brand", href: HOME[locale] },
			logoNode({ size: 24 }),
			h("span", {}, "Radarnaque"),
		),
		h(
			"ul",
			{ class: "site-nav__links" },
			h("li", {}, h("a", { href: anchor("comment") }, t.howItWorks)),
			h("li", {}, h("a", { href: anchor("formules") }, t.plans)),
			h(
				"li",
				{},
				h(
					"a",
					{
						href: `/privacy/?lang=${locale}`,
						"aria-current": page === "privacy" ? "page" : undefined,
					},
					t.privacy,
				),
			),
		),
		h(
			"a",
			{
				class: "site-nav__lang",
				href: langHref,
				hreflang: other,
				lang: other,
				"aria-label": t.langLabel,
				"data-lang-switch": true,
			},
			t.langCode,
		),
	);
}

/** Pied de page : ce que l'extension lit et garde, puis les liens utiles. */
export function footerNode(locale: Locale): VNode {
	const t = LAYOUT_TEXT[locale];
	const link = (href: string, text: string) =>
		h("li", {}, h("a", { href }, text));
	return h(
		"footer",
		{ class: "site-footer" },
		h(
			"p",
			{ class: "site-footer__data" },
			fill(t.footerData, { months: PRIVACY_RETENTION_MONTHS }),
		),
		h(
			"ul",
			{ class: "site-footer__links" },
			link(`/pricing/?lang=${locale}`, t.plans),
			link(`/privacy/?lang=${locale}`, t.privacy),
			link(SOURCE_CODE_URL, t.sourceCode),
			link(`mailto:${PRIVACY_EMAIL}`, t.contact),
		),
	);
}
