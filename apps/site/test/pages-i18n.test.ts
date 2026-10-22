// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { detectLocale } from "../src/i18n";
import type { Offer } from "../src/offer";
import {
	formatCents,
	formatInt,
	PLANS,
	PRICING,
	PRIVACY_EMAIL,
	PRIVACY_RETENTION_MONTHS,
} from "../src/pages-i18n";
import { renderPricing, renderPrivacy } from "../src/pages-render";
import { PRIVACY, PRIVACY_ORDER } from "../src/privacy-i18n";

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
	it("every string is non-empty, and FR differs from NL except plan names", () => {
		const sameInBothLanguages = new Set([
			"pricing.plans.standard.name",
			"pricing.plans.premium.name",
		]);
		const walk = (fr: unknown, nl: unknown, path: string) => {
			if (typeof fr === "string") {
				expect(fr.length, path).toBeGreaterThan(0);
				expect((nl as string).length, path).toBeGreaterThan(0);
				if (!sameInBothLanguages.has(path)) expect(fr, path).not.toBe(nl);
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

describe("PLANS (offre de secours)", () => {
	it("holds the exact prices in cents and quotas", () => {
		expect(PLANS.trial.scans).toBe(3);
		expect(PLANS.standard).toMatchObject({
			monthlyCents: 299,
			yearlyCents: 2900,
			scans: 150,
			maxImages: 1,
			cardIcons: false,
		});
		expect(PLANS.premium).toMatchObject({
			monthlyCents: 699,
			yearlyCents: 6900,
			scans: 300,
			maxImages: 4,
			cardIcons: true,
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
				for (const needle of ["2,99", "29", "6,99", "69", "150", "300"]) {
					expect(text, needle).toContain(needle);
				}
				const trial = norm(root.querySelector("article.plan")?.textContent);
				const firstFeature = root.querySelector("article.plan li")?.textContent;
				expect(norm(firstFeature)).toMatch(/^3 /);
				expect(trial).toContain(firstFeature);
			});

			it("premium lists the listing-page AI button and the search icons", () => {
				renderPricing(document, root, locale);
				const premium = root.querySelectorAll("article.plan")[2];
				const items = [...premium.querySelectorAll("li")].map((li) =>
					norm(li.textContent),
				);
				expect(items).toHaveLength(4);
				expect(items.join("|")).toContain(
					locale === "fr" ? "page de l'annonce" : "pagina van de advertentie",
				);
				expect(premium.textContent).not.toMatch(/sans limite|zonder limiet/i);
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
				expect(link?.getAttribute("href")).toBe(`/pricing/?lang=${other}`);
				expect(link?.getAttribute("hreflang")).toBe(other);
			});

			it("renders the exact lines of each card from the fallback offer", () => {
				renderPricing(document, root, locale);
				const cards = [...root.querySelectorAll("article.plan")].map((card) =>
					[...card.querySelectorAll("li")].map((li) => norm(li.textContent)),
				);
				const fr = locale === "fr";
				const button = fr
					? "Bouton d'analyse IA sur la page de l'annonce"
					: "AI-analyseknop op de pagina van de advertentie";
				const icons = fr
					? "Icônes sur les résultats de recherche"
					: "Iconen op de zoekresultaten";
				expect(cards[0]).toEqual([
					fr ? "3 analyses offertes au total" : "3 gratis analyses in totaal",
					fr
						? "Jusqu'à 4 photos analysées par annonce"
						: "Tot 4 foto's geanalyseerd per advertentie",
					button,
					icons,
				]);
				expect(cards[1]).toEqual([
					fr ? "150 analyses par mois" : "150 analyses per maand",
					fr
						? "1 photo analysée par annonce"
						: "1 foto geanalyseerd per advertentie",
					button,
				]);
				expect(cards[2]).toEqual([
					fr ? "300 analyses par mois" : "300 analyses per maand",
					fr
						? "Jusqu'à 4 photos analysées par annonce"
						: "Tot 4 foto's geanalyseerd per advertentie",
					button,
					icons,
				]);
			});

			it("renders the offer given by the API", () => {
				const offer: Offer = {
					...PLANS,
					premium: { ...PLANS.premium, scans: 400, monthlyCents: 799 },
				};
				renderPricing(document, root, locale, offer);
				const premium = norm(
					root.querySelectorAll("article.plan")[2].textContent,
				);
				expect(premium).toContain(
					locale === "fr" ? "400 analyses par mois" : "400 analyses per maand",
				);
				expect(premium).toContain("7,99");
				expect(premium).not.toContain("300");
			});

			it("drops the icons line when the plan has no card icons", () => {
				const offer: Offer = {
					...PLANS,
					premium: { ...PLANS.premium, cardIcons: false },
				};
				renderPricing(document, root, locale, offer);
				const premium = root.querySelectorAll("article.plan")[2];
				expect(premium.querySelectorAll("li")).toHaveLength(3);
				expect(premium.textContent).not.toMatch(/Icônes|Iconen/);
			});

			it("words the photo line by count: none, one, many", () => {
				const withImages = (n: number) => {
					renderPricing(document, root, locale, {
						...PLANS,
						standard: { ...PLANS.standard, maxImages: n },
					});
					return norm(
						root.querySelectorAll("article.plan")[1].querySelectorAll("li")[1]
							.textContent,
					);
				};
				const fr = locale === "fr";
				expect(withImages(0)).toBe(
					fr ? "Pas de photo analysée" : "Geen foto's geanalyseerd",
				);
				expect(withImages(1)).toBe(
					fr
						? "1 photo analysée par annonce"
						: "1 foto geanalyseerd per advertentie",
				);
				expect(withImages(4)).toBe(
					fr
						? "Jusqu'à 4 photos analysées par annonce"
						: "Tot 4 foto's geanalyseerd per advertentie",
				);
				expect(root.textContent).not.toContain("0 photo");
			});

			it("shows no price (and no VAT note) for a paid plan without price", () => {
				renderPricing(document, root, locale, {
					...PLANS,
					standard: {
						...PLANS.standard,
						monthlyCents: null,
						yearlyCents: null,
					},
				});
				const standard = root.querySelectorAll("article.plan")[1];
				expect(standard.querySelectorAll("p.price")).toHaveLength(0);
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

describe("privacy wording (spec 10)", () => {
	const text = (l: "fr" | "nl") =>
		Object.values(PRIVACY[l].sections)
			.map((x) => `${x.heading} ${x.body}`)
			.join(" ");

	it("orders every section exactly once", () => {
		expect([...PRIVACY_ORDER].sort()).toEqual(
			Object.keys(PRIVACY.fr.sections).sort(),
		);
	});

	it("FR and NL declare the same sections, in the display order", () => {
		expect(Object.keys(PRIVACY.fr.sections)).toEqual([...PRIVACY_ORDER]);
		expect(Object.keys(PRIVACY.nl.sections)).toEqual([...PRIVACY_ORDER]);
	});

	it("places the web search and browser sections right after the photos", () => {
		const order = [...PRIVACY_ORDER];
		expect(order.indexOf("web")).toBe(order.indexOf("photos") + 1);
		expect(order.indexOf("browser")).toBe(order.indexOf("web") + 1);
		for (const l of ["fr", "nl"] as const) {
			expect(PRIVACY[l].sections.web.body.length).toBeGreaterThan(0);
			expect(PRIVACY[l].sections.browser.body.length).toBeGreaterThan(0);
		}
	});

	it("photos apply to every analysis, not only to Premium", () => {
		for (const l of ["fr", "nl"] as const) {
			expect(PRIVACY[l].sections.photos.heading).not.toContain("Premium");
			expect(PRIVACY[l].sections.photos.body).toMatch(/Standard/);
			expect(PRIVACY[l].sections.photos.body).toMatch(/\b4\b/);
		}
		expect(PRIVACY.fr.sections.photos.body).toMatch(/^Une analyse IA envoie/);
		expect(PRIVACY.nl.sections.photos.body).toMatch(/^Een AI-analyse stuurt/);
	});

	it("discloses the web search: at most 3, no seller identity, masked contacts", () => {
		const fr = PRIVACY.fr.sections.web.body;
		const nl = PRIVACY.nl.sections.web.body;
		expect(fr).toMatch(/3 recherches/);
		expect(fr).toMatch(/ni l'identité du vendeur/);
		expect(fr).toMatch(/masqués/);
		expect(nl).toMatch(/3 zoekopdrachten/);
		expect(nl).toMatch(/identiteit van de verkoper/);
		expect(nl).toMatch(/gemaskeerd/);
	});

	it("says the AI result is kept 24 h in the browser and erased at sign-out", () => {
		expect(PRIVACY.fr.sections.browser.body).toMatch(/24 h/);
		expect(PRIVACY.fr.sections.browser.body).toMatch(/déconnexion/);
		expect(PRIVACY.nl.sections.browser.body).toMatch(/24 uur/);
		expect(PRIVACY.nl.sections.browser.body).toMatch(/afmeldt|uitlogt/);
	});

	it("keeps only the trial count after the retention period", () => {
		expect(PRIVACY.fr.sections.kept.body).toContain("{months}");
		expect(PRIVACY.nl.sections.kept.body).toContain("{months}");
		expect(PRIVACY.fr.sections.kept.body).toMatch(/essai/);
		expect(PRIVACY.nl.sections.kept.body).toMatch(/proef/);
	});

	it("kept names the session IP address and browser, erased at sign-out and deletion", () => {
		const fr = PRIVACY.fr.sections.kept.body;
		const nl = PRIVACY.nl.sections.kept.body;
		expect(fr).toMatch(/session de connexion/);
		expect(fr).toMatch(/adresse IP et le navigateur/);
		expect(fr).toMatch(
			/quand vous vous déconnectez et quand vous supprimez votre compte/,
		);
		expect(nl).toMatch(/aanmeldsessie/);
		expect(nl).toMatch(/IP-adres en de browser/);
		expect(nl).toMatch(
			/wanneer u zich afmeldt en wanneer u uw account verwijdert/,
		);
	});

	it("erasure names the popup button and gives the contact address", () => {
		expect(PRIVACY.fr.sections.erasure.body).toContain("Supprimer mon compte");
		expect(PRIVACY.nl.sections.erasure.body).toContain(
			"Mijn account verwijderen",
		);
		expect(PRIVACY.fr.sections.erasure.body).toContain("{email}");
		expect(PRIVACY.nl.sections.erasure.body).toContain("{email}");
		expect(PRIVACY.nl.sections.erasure.body).not.toContain("«");
	});

	it("erasure does not promise that backups are gone at once", () => {
		const fr = PRIVACY.fr.sections.erasure.body;
		const nl = PRIVACY.nl.sections.erasure.body;
		expect(fr).not.toMatch(/définitiv/);
		expect(nl).not.toMatch(/definitie?f/);
		expect(fr).toMatch(/copies de sauvegarde chiffrées/);
		expect(fr).toMatch(/14 jours/);
		expect(nl).toMatch(/versleutelde back-ups/);
		expect(nl).toMatch(/14 dagen/);
	});

	it("hosting names the external backup copy and the email provider (Resend)", () => {
		const fr = PRIVACY.fr.sections.hosting.body;
		const nl = PRIVACY.nl.sections.hosting.body;
		expect(fr).toMatch(/stockage externe/);
		expect(fr).toContain("Resend");
		expect(fr).toMatch(/Resend\)[^.]*hors de l'UE/);
		expect(nl).toMatch(/externe opslag/);
		expect(nl).toContain("Resend");
		expect(nl).toMatch(/Resend\)[^.]*buiten de EU/);
	});

	it("shows a retention that matches the API purge (SCAN_RETENTION_MONTHS = 12)", () => {
		// Doit rester égal à SCAN_RETENTION_MONTHS dans services/api (purge à 12 mois).
		expect(PRIVACY_RETENTION_MONTHS).toBe(12);
	});

	it("does not promise that the AI provider keeps nothing", () => {
		expect(text("fr")).not.toMatch(/ne conserve rien|ni conserver/);
		expect(text("nl")).not.toMatch(/bewaart niets|niet bewaart/);
		expect(PRIVACY.fr.sections.ai.heading).toBe("Données envoyées à l'IA");
		expect(PRIVACY.fr.sections.ai.body).toContain("Nous demandons");
		expect(PRIVACY.nl.sections.ai.body).toContain("Wij vragen");
	});

	it("erasure removes the analysis history, not the analyses", () => {
		expect(PRIVACY.fr.sections.erasure.body).toContain(
			"l'historique de vos analyses",
		);
		expect(PRIVACY.nl.sections.erasure.body).toContain(
			"de geschiedenis van uw analyses",
		);
		expect(PRIVACY.nl.sections.erasure.body).toContain(
			"worden uw gebruikersgegevens, uw abonnementen en de geschiedenis van uw analyses gewist",
		);
		expect(PRIVACY.nl.sections.erasure.body).not.toContain("gebruikersaccount");
		expect(PRIVACY.nl.sections.erasure.body).toContain("mailen naar {email}");
	});

	it("does not claim everything stays in the EU", () => {
		expect(PRIVACY.fr.sections.hosting.heading).toBe(
			"Où sont traitées les données",
		);
		expect(PRIVACY.fr.sections.hosting.body).toMatch(/hors de l'UE/);
		expect(PRIVACY.nl.sections.hosting.body).toMatch(/buiten de EU/);
	});

	it("discloses triggers, photo download and non-identifying seller facts", () => {
		expect(PRIVACY.fr.sections.trigger.body).toMatch(/clic|demandez/);
		expect(PRIVACY.fr.sections.photos.body).toMatch(
			/téléchargées par notre serveur/,
		);
		expect(PRIVACY.fr.sections.seller.body).toMatch(/avant l'envoi à l'IA/);
		expect(PRIVACY.fr.sections.seller.body).toMatch(/ancienneté/);
		expect(PRIVACY.nl.sections.seller.body).toMatch(/voordat/);
		expect(PRIVACY.nl.sections.seller.body).toContain("gemaskeerd");
		expect(PRIVACY.nl.sections.photos.body).toMatch(/gedownload/);
	});

	it("says every AI analysis is triggered by a click (spec §2.1)", () => {
		expect(PRIVACY.fr.sections.trigger.body).toBe(
			"Une analyse IA n'est faite que lorsque vous la demandez, par un clic (bouton sur l'annonce, ou icône sur les résultats de recherche avec Premium).",
		);
		expect(PRIVACY.nl.sections.trigger.body).toBe(
			"Een AI-analyse gebeurt alleen wanneer u erom vraagt, met een klik (knop op de advertentie, of icoon op de zoekresultaten met Premium).",
		);
		// Rien ne doit laisser croire à une analyse automatique à l'affichage des résultats.
		expect(PRIVACY.fr.sections.trigger.body).not.toMatch(/pour afficher/);
		expect(PRIVACY.nl.sections.trigger.body).not.toMatch(/te tonen/);
	});

	it("uses the agreed NL wording", () => {
		expect(PRICING.nl.plans.premium.features.icons).toMatch(/iconen/i);
		expect(text("nl")).not.toContain("afgeschermd");
		expect(PRIVACY.nl.sections.seller.body).toContain(
			"Alleen gegevens die de verkoper niet identificeren",
		);
		expect(PRIVACY.nl.sections.seller.body).toContain(
			"hoe lang het account al bestaat",
		);
		expect(PRIVACY.nl.sections.seller.body).not.toContain(
			"leeftijd van het account",
		);
	});
});

describe("pricing wording (offre actuelle)", () => {
	it("n'a plus les anciens textes de texte / photos par mois", () => {
		const all = JSON.stringify(PRICING);
		for (const old of [
			"analyses de texte",
			"analyses avec photos",
			"tekstanalyses",
			"met foto's per maand",
			"Toutes les fonctionnalités",
			"Alle functies",
		]) {
			expect(all, old).not.toContain(old);
		}
	});

	it("garde les textes du bouton et des icônes", () => {
		expect(PRICING.fr.plans.premium.features.button).toBe(
			"Bouton d'analyse IA sur la page de l'annonce",
		);
		expect(PRICING.fr.plans.premium.features.icons).toBe(
			"Icônes sur les résultats de recherche",
		);
		expect(PRICING.nl.plans.premium.features.button).toBe(
			"AI-analyseknop op de pagina van de advertentie",
		);
		expect(PRICING.nl.plans.premium.features.icons).toBe(
			"Iconen op de zoekresultaten",
		);
	});
});

describe("static pages", () => {
	for (const page of ["pricing", "privacy"] as const) {
		it(`${page}/index.html has a noscript fallback in both languages`, () => {
			const html = readFileSync(
				resolve(import.meta.dirname, "..", page, "index.html"),
				"utf8",
			);
			expect(html).toContain("<noscript>");
			expect(html).toContain("Activez JavaScript pour afficher cette page.");
			expect(html).toContain(
				'<p lang="nl">Schakel JavaScript in om deze pagina te bekijken.</p>',
			);
		});
	}
});
