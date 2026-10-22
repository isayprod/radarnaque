// @vitest-environment happy-dom
import { logoSvg } from "@radarnaque/design/logo";
import { beforeEach, describe, expect, it } from "vitest";
import { toDom, toHtml, type VNode } from "../src/h";
import {
	footerNode,
	LAYOUT_TEXT,
	logoNode,
	navNode,
	SOURCE_CODE_URL,
} from "../src/layout";
import { PRIVACY_EMAIL, PRIVACY_RETENTION_MONTHS } from "../src/pages-i18n";
import { renderPricing, renderPrivacy } from "../src/pages-render";

/** Arbre canonique d'un élément : balise, attributs triés, enfants. */
type Forme = string | { tag: string; attrs: string[]; children: Forme[] };
function forme(node: Node): Forme {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
	const el = node as Element;
	return {
		tag: el.tagName.toLowerCase(),
		attrs: [...el.attributes].map((a) => `${a.name}=${a.value}`).sort(),
		children: [...el.childNodes].map(forme),
	};
}
function formeDuHtml(html: string): Forme {
	const box = document.createElement("div");
	box.innerHTML = html;
	return forme(box.firstChild as Node);
}

/** Rend un nœud dans le document et renvoie l'élément. */
const dom = (node: VNode) => toDom(document, node) as HTMLElement;
const hrefs = (el: Element, selector = "a") =>
	[...el.querySelectorAll(selector)].map((a) => a.getAttribute("href"));

describe("logoNode", () => {
	it.each([
		[{}, {}],
		[{ size: 24 }, { size: 24 }],
		[{ animated: true }, { animated: true }],
		[
			{ animated: true, size: 40 },
			{ animated: true, size: 40 },
		],
	])("même SVG que logoSvg(%o), à l'ordre des attributs près", (opts, ref) => {
		expect(formeDuHtml(toHtml(logoNode(opts)))).toEqual(
			formeDuHtml(logoSvg(ref)),
		);
	});

	it("rendu DOM : SVG dans son espace de noms, décoratif", () => {
		const svg = dom(logoNode({ size: 24 }));
		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg.getAttribute("aria-hidden")).toBe("true");
		expect(svg.querySelectorAll("circle")).toHaveLength(2);
	});
});

describe("navNode", () => {
	it('navNode("nl", "pricing") : lien de langue vers /pricing/?lang=fr, ancres vers /nl/#comment et /nl/#formules', () => {
		const nav = dom(navNode("nl", "pricing"));
		const t = LAYOUT_TEXT.nl;
		const lang = nav.querySelector("a[data-lang-switch]");
		expect(lang?.getAttribute("href")).toBe("/pricing/?lang=fr");
		expect(lang?.getAttribute("hreflang")).toBe("fr");
		expect(lang?.getAttribute("lang")).toBe("fr");
		expect(lang?.textContent).toBe("FR");
		const links = [...nav.querySelectorAll(".site-nav__links a")];
		expect(links.map((a) => a.textContent)).toEqual([
			t.howItWorks,
			t.plans,
			t.privacy,
		]);
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"/nl/#comment",
			"/nl/#formules",
			"/privacy/?lang=nl",
		]);
	});

	it('navNode("fr", "pricing") : ancres vers /#comment et /#formules', () => {
		const nav = dom(navNode("fr", "pricing"));
		expect(hrefs(nav, ".site-nav__links a")).toEqual([
			"/#comment",
			"/#formules",
			"/privacy/?lang=fr",
		]);
		expect(nav.querySelector("a[data-lang-switch]")?.getAttribute("href")).toBe(
			"/pricing/?lang=nl",
		);
	});

	it('navNode("fr", "home") : ancres #comment et #formules, lien de langue vers /nl/', () => {
		const nav = dom(navNode("fr", "home"));
		expect(hrefs(nav, ".site-nav__links a")).toEqual([
			"#comment",
			"#formules",
			"/privacy/?lang=fr",
		]);
		const lang = nav.querySelector("a[data-lang-switch]");
		expect(lang?.getAttribute("href")).toBe("/nl/");
		expect(lang?.textContent).toBe("NL");
	});

	it('navNode("nl", "home") : lien de langue vers /', () => {
		const nav = dom(navNode("nl", "home"));
		expect(nav.querySelector("a[data-lang-switch]")?.getAttribute("href")).toBe(
			"/",
		);
		expect(hrefs(nav, ".site-nav__links a").slice(0, 2)).toEqual([
			"#comment",
			"#formules",
		]);
	});

	it("logo et « Radarnaque » mènent à l'accueil de la langue", () => {
		for (const [locale, home] of [
			["fr", "/"],
			["nl", "/nl/"],
		] as const) {
			const brand = dom(navNode(locale, "privacy")).querySelector(
				".site-nav__brand",
			);
			expect(brand?.getAttribute("href")).toBe(home);
			expect(brand?.querySelector("svg")).not.toBeNull();
			expect(brand?.textContent).toBe("Radarnaque");
		}
	});

	it("page courante marquée sur /privacy, nom accessible du lien de langue", () => {
		const nav = dom(navNode("fr", "privacy"));
		expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe(
			LAYOUT_TEXT.fr.privacy,
		);
		expect(
			dom(navNode("fr", "pricing")).querySelector("[aria-current]"),
		).toBeNull();
		// Le texte visible (« NL ») fait partie du nom accessible.
		const label =
			nav.querySelector("a[data-lang-switch]")?.getAttribute("aria-label") ??
			"";
		expect(label).toContain("NL");
		expect(nav.getAttribute("aria-label")).toBe(LAYOUT_TEXT.fr.navLabel);
	});
});

describe("footerNode", () => {
	it("footerNode : quatre liens, mailto de PRIVACY_EMAIL, dépôt GitHub", () => {
		for (const locale of ["fr", "nl"] as const) {
			const footer = dom(footerNode(locale));
			const t = LAYOUT_TEXT[locale];
			expect(footer.tagName).toBe("FOOTER");
			const links = [...footer.querySelectorAll("a")];
			expect(links.map((a) => a.textContent)).toEqual([
				t.plans,
				t.privacy,
				t.sourceCode,
				t.contact,
			]);
			expect(links.map((a) => a.getAttribute("href"))).toEqual([
				`/pricing/?lang=${locale}`,
				`/privacy/?lang=${locale}`,
				"https://github.com/isayprod/radarnaque",
				`mailto:${PRIVACY_EMAIL}`,
			]);
			expect(SOURCE_CODE_URL).toBe("https://github.com/isayprod/radarnaque");
		}
	});

	it("phrase sur les données du spec landing §3.8, durée de conservation partagée", () => {
		const fr = dom(footerNode("fr")).querySelector("p")?.textContent;
		expect(fr).toBe(
			"Radarnaque ne lit que la page de l'annonce que vous analysez, au moment où vous cliquez. Les analyses sont conservées 12 mois puis effacées ; vous pouvez supprimer votre compte à tout moment depuis l'extension.",
		);
		const nl = dom(footerNode("nl")).querySelector("p")?.textContent ?? "";
		expect(nl).toContain(`${PRIVACY_RETENTION_MONTHS} maanden`);
		expect(nl).not.toContain("{");
	});
});

describe("LAYOUT_TEXT", () => {
	it("FR et NL : mêmes clés, aucun texte vide, NL au tutoiement flamand (je)", () => {
		expect(Object.keys(LAYOUT_TEXT.nl).sort()).toEqual(
			Object.keys(LAYOUT_TEXT.fr).sort(),
		);
		for (const locale of ["fr", "nl"] as const) {
			for (const [key, value] of Object.entries(LAYOUT_TEXT[locale]))
				expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
		}
		expect(LAYOUT_TEXT.nl.footerData).toMatch(/\bje\b/);
		expect(LAYOUT_TEXT.nl.footerData).not.toMatch(/\bu\b/);
	});
});

describe("pages rendues avec la navigation et le pied de page", () => {
	let root: HTMLElement;
	beforeEach(() => {
		document.body.innerHTML = '<div id="app"></div>';
		root = document.getElementById("app") as HTMLElement;
	});

	for (const locale of ["fr", "nl"] as const) {
		it(`/pricing (${locale}) : navigation, contenu principal, pied de page`, () => {
			renderPricing(document, root, locale);
			expect([...root.children].map((el) => el.tagName.toLowerCase())).toEqual([
				"header",
				"main",
				"footer",
			]);
			expect(root.querySelector("header nav.site-nav")).not.toBeNull();
			expect(root.querySelector("main h1")?.textContent).toBeTruthy();
			expect(root.querySelectorAll("main article.plan")).toHaveLength(3);
			expect(
				root.querySelector("a[data-lang-switch]")?.getAttribute("href"),
			).toBe(`/pricing/?lang=${locale === "fr" ? "nl" : "fr"}`);
			expect(
				root.querySelector('footer a[href^="mailto:"]')?.getAttribute("href"),
			).toBe(`mailto:${PRIVACY_EMAIL}`);
			// Re-rendu (offre de l'API) : rien n'est dupliqué.
			renderPricing(document, root, locale);
			expect(root.querySelectorAll("nav.site-nav")).toHaveLength(1);
			expect(root.querySelectorAll("footer")).toHaveLength(1);
		});

		it(`/privacy (${locale}) : navigation, contenu principal, pied de page`, () => {
			renderPrivacy(document, root, locale);
			expect([...root.children].map((el) => el.tagName.toLowerCase())).toEqual([
				"header",
				"main",
				"footer",
			]);
			expect(
				root.querySelector("a[data-lang-switch]")?.getAttribute("href"),
			).toBe(`/privacy/?lang=${locale === "fr" ? "nl" : "fr"}`);
			expect(root.querySelector("main section")).not.toBeNull();
			expect(root.querySelector("footer")).not.toBeNull();
		});
	}

	it("/pricing : la formule Standard est mise en avant", () => {
		renderPricing(document, root, "fr");
		const plans = [...root.querySelectorAll("article.plan")];
		expect(plans.map((p) => p.getAttribute("data-plan"))).toEqual([
			"trial",
			"standard",
			"premium",
		]);
		expect(plans.map((p) => p.classList.contains("plan--featured"))).toEqual([
			false,
			true,
			false,
		]);
	});
});
