// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { detectLocale } from "../src/i18n";
import {
	formatCents,
	formatInt,
	PLANS,
	PRICING,
	PRIVACY,
	PRIVACY_EMAIL,
} from "../src/pages-i18n";
import { renderPricing, renderPrivacy } from "../src/pages-render";

function keyTree(value: unknown): unknown {
	if (typeof value === "string") return "string";
	if (Array.isArray(value)) return value.map(keyTree);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, keyTree((value as Record<string, unknown>)[k])]),
		);
	}
	return typeof value;
}

// Intl uses narrow/no-break spaces; compare with plain spaces.
const norm = (s: string | null | undefined) => (s ?? "").replace(/[  ]/g, " ");

describe("FR/NL parity", () => {
	it("pricing dictionaries have exactly the same key tree", () => {
		expect(keyTree(PRICING.fr)).toEqual(keyTree(PRICING.nl));
	});
	it("privacy dictionaries have exactly the same key tree", () => {
		expect(keyTree(PRIVACY.fr)).toEqual(keyTree(PRIVACY.nl));
	});
	it("every string is non-empty and differs between FR and NL", () => {
		const walk = (fr: unknown, nl: unknown, path: string) => {
			if (typeof fr === "string") {
				expect(fr.length, path).toBeGreaterThan(0);
				expect((nl as string).length, path).toBeGreaterThan(0);
				return;
			}
			for (const k of Object.keys(fr as object)) {
				walk(
					(fr as Record<string, unknown>)[k],
					(nl as Record<string, unknown>)[k],
					`${path}.${k}`,
				);
			}
		};
		walk(PRICING.fr, PRICING.nl, "pricing");
		walk(PRIVACY.fr, PRIVACY.nl, "privacy");
	});
});

describe("PLANS (spec 2.2)", () => {
	it("holds the exact prices in cents and quotas", () => {
		expect(PLANS.trial.scans).toBe(3);
		expect(PLANS.standard).toMatchObject({
			monthlyCents: 299,
			yearlyCents: 2900,
			textPerMonth: 150,
			photoPerMonth: 0,
		});
		expect(PLANS.premium).toMatchObject({
			monthlyCents: 699,
			yearlyCents: 6900,
			textPerMonth: 1000,
			photoPerMonth: 100,
		});
	});
	it("formats euros per locale", () => {
		expect(norm(formatCents(299, "fr"))).toBe("2,99 €");
		expect(norm(formatCents(2900, "fr"))).toBe("29 €");
		expect(norm(formatCents(699, "nl"))).toBe("€ 6,99");
		expect(norm(formatCents(6900, "nl"))).toBe("€ 69");
		expect(norm(formatInt(1000, "fr"))).toBe("1 000");
		expect(formatInt(1000, "nl")).toBe("1.000");
	});
});

describe("detectLocale", () => {
	it("?lang wins over the browser language", () => {
		expect(detectLocale("?lang=nl", "fr-BE")).toBe("nl");
		expect(detectLocale("?lang=fr", "nl-BE")).toBe("fr");
	});
	it("falls back to the browser language, then fr", () => {
		expect(detectLocale("", "nl-BE")).toBe("nl");
		expect(detectLocale("?lang=de", "nl-BE")).toBe("nl");
		expect(detectLocale("?x=1", "en-US")).toBe("fr");
		expect(detectLocale("", undefined)).toBe("fr");
	});
});

describe("renderPricing", () => {
	let root: HTMLElement;
	beforeEach(() => {
		document.body.innerHTML = '<main id="app"></main>';
		root = document.getElementById("app") as HTMLElement;
	});

	for (const locale of ["fr", "nl"] as const) {
		describe(locale, () => {
			it("renders 3 cards with the spec prices and quotas", () => {
				renderPricing(document, root, locale);
				expect(root.querySelectorAll("article.plan")).toHaveLength(3);
				const text = norm(root.textContent);
				for (const needle of ["2,99", "29", "6,99", "69", "150", "100"]) {
					expect(text, needle).toContain(needle);
				}
				expect(text).toContain(locale === "fr" ? "1 000" : "1.000");
				const trial = norm(root.querySelector("article.plan")?.textContent);
				expect(trial).toMatch(/(^|\D)3 /);
			});

			it("has no working buy button and says payment is coming", () => {
				renderPricing(document, root, locale);
				expect(
					root.querySelectorAll("button, form, a[href*=checkout]"),
				).toHaveLength(0);
				expect(root.textContent).toContain(
					locale === "fr"
						? "Paiement bientôt disponible"
						: "Betalen binnenkort beschikbaar",
				);
			});

			it("sets <html lang> and links to the other language", () => {
				renderPricing(document, root, locale);
				expect(document.documentElement.lang).toBe(locale);
				const other = locale === "fr" ? "nl" : "fr";
				const link = root.querySelector<HTMLAnchorElement>(
					"a[data-lang-switch]",
				);
				expect(link?.getAttribute("href")).toBe(`?lang=${other}`);
				expect(link?.getAttribute("hreflang")).toBe(other);
			});

			it("re-rendering replaces the content instead of appending", () => {
				renderPricing(document, root, locale);
				renderPricing(document, root, locale);
				expect(root.querySelectorAll("article.plan")).toHaveLength(3);
			});
		});
	}
});

describe("renderPrivacy", () => {
	let root: HTMLElement;
	beforeEach(() => {
		document.body.innerHTML = '<main id="app"></main>';
		root = document.getElementById("app") as HTMLElement;
	});

	for (const locale of ["fr", "nl"] as const) {
		it(`renders every section and a mailto link (${locale})`, () => {
			renderPrivacy(document, root, locale);
			expect(document.documentElement.lang).toBe(locale);
			expect(root.querySelectorAll("section")).toHaveLength(
				Object.keys(PRIVACY[locale].sections).length,
			);
			const mail = root.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
			expect(mail?.getAttribute("href")).toBe(`mailto:${PRIVACY_EMAIL}`);
			expect(root.textContent).not.toContain("{");
			expect(root.textContent).toContain("12");
		});
	}

	it("never interprets dictionary text as HTML", () => {
		renderPrivacy(document, root, "fr");
		expect(root.querySelectorAll("script, img")).toHaveLength(0);
	});
});
