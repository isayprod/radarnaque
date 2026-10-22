// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locale } from "@radarnaque/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { escapeHtml } from "../src/h";
import { renderHead } from "../src/landing/head";
import { LANDING_TEXT } from "../src/landing/i18n";
import { landingPlugin } from "../src/landing/plugin";
import { renderLanding } from "../src/landing/render";
import { LAYOUT_TEXT } from "../src/layout";
import type { Offer } from "../src/offer";
import { fill, formatCents, PLANS, PRICING } from "../src/pages-i18n";
import { featureLines } from "../src/plan-lines";

const SITE = resolve(import.meta.dirname, "..");
const STORE =
	"https://chromewebstore.google.com/detail/radarnaque/abcdefghijklmnop";
const PUBLIC = "https://radarnaque.example.test";
const LOCALES: Locale[] = ["fr", "nl"];

/** Toutes les chaînes d'un objet de textes, en profondeur. */
function chaines(valeur: unknown): string[] {
	if (typeof valeur === "string") return [valeur];
	if (Array.isArray(valeur)) return valeur.flatMap(chaines);
	if (valeur && typeof valeur === "object")
		return Object.values(valeur).flatMap(chaines);
	return [];
}

/**
 * Textes propres à une langue : ceux qui n'apparaissent dans aucun texte de
 * l'autre langue (« Formules », « 12/100 » sont communs ; « Analyser » est
 * contenu dans « Analyseren »).
 */
function propres(langue: Locale, autre: Locale): string[] {
	const autres = chaines(LANDING_TEXT[autre]);
	return chaines(LANDING_TEXT[langue]).filter(
		(texte) => !autres.some((a) => a.includes(texte)),
	);
}

/** Le HTML contient-il ce texte, tel que le rendu au build l'échappe ? */
const contient = (html: string, texte: string) =>
	html.includes(escapeHtml(texte));

/** Monte le corps rendu dans le document et renvoie la racine. */
function monter(html: string): HTMLElement {
	document.body.innerHTML = html;
	return document.body;
}

const rendu = (
	locale: Locale,
	storeUrl: string | null = STORE,
	offer = PLANS,
) => renderLanding(locale, { offer, storeUrl });

beforeEach(() => {
	document.head.replaceChildren();
	document.body.replaceChildren();
});

describe("renderLanding : textes", () => {
	it("FR : textes du spec (titre du hero, accroche, ligne discrète, bouton, titres des sections, phrase du pied de page), aucun texte NL", () => {
		const html = rendu("fr");
		for (const texte of [
			"Repérez l'arnaque avant de payer.",
			"Radarnaque lit l'annonce et ses photos sur 2ememain, 2dehands et Facebook Marketplace, et vous dit en quelques secondes si quelque chose cloche.",
			"Extension pour Chrome · essai gratuit, sans carte bancaire",
			"Ajouter à Chrome, c'est gratuit",
			"Analyse du texte et des photos",
			"Comparaison avec le prix du marché",
			"Verdict en quelques secondes",
			"En français et en néerlandais",
			"Trois gestes, avant d'envoyer le moindre euro.",
			"Commencez gratuitement.",
			"Paiement bientôt disponible.",
			"Détail des formules",
			"Le bon réflexe avant chaque achat d'occasion.",
			"Chrome, Edge, Brave et autres navigateurs Chromium",
			"Politique de confidentialité",
			"Code source",
			"Radarnaque ne lit que la page de l'annonce que vous analysez, au moment où vous cliquez. Les analyses sont conservées 12 mois puis effacées ; vous pouvez supprimer votre compte à tout moment depuis l'extension.",
		]) {
			expect(contient(html, texte), texte).toBe(true);
		}
		// Aucun texte NL (hors chaînes communes aux deux langues).
		for (const texte of propres("nl", "fr"))
			expect(contient(html, texte), texte).toBe(false);
		expect(contient(html, LAYOUT_TEXT.nl.footerData.slice(0, 40))).toBe(false);
	});

	it("NL : textes NL, aucun texte FR", () => {
		const html = rendu("nl");
		const t = LANDING_TEXT.nl;
		for (const texte of [
			t.heroTitle,
			t.heroTagline,
			t.heroNote,
			t.install,
			...t.benefits,
			t.howTitle,
			t.plansTitle,
			t.installTitle,
		]) {
			expect(contient(html, texte), texte).toBe(true);
		}
		for (const texte of propres("fr", "nl"))
			expect(contient(html, texte), texte).toBe(false);
		expect(contient(html, LAYOUT_TEXT.fr.footerData.slice(0, 40))).toBe(false);
	});

	it("FR et NL : mêmes clés, aucun texte vide, NL au tutoiement flamand (je)", () => {
		const cles = (o: object): string[] =>
			Object.entries(o).flatMap(([k, v]) =>
				v && typeof v === "object" ? cles(v).map((s) => `${k}.${s}`) : [k],
			);
		expect(cles(LANDING_TEXT.nl)).toEqual(cles(LANDING_TEXT.fr));
		for (const texte of [
			...chaines(LANDING_TEXT.fr),
			...chaines(LANDING_TEXT.nl),
		])
			expect(texte.trim().length).toBeGreaterThan(0);
		const nl = chaines(LANDING_TEXT.nl).join(" ");
		expect(nl).not.toMatch(/\b(u|uw)\b/i);
		expect(nl).toMatch(/\bje\b/);
	});

	it("structure : navigation, emplacement de la maquette, ancres #comment et #formules, pied de page", () => {
		const root = monter(rendu("fr"));
		expect(root.querySelector("nav.site-nav")).not.toBeNull();
		expect(root.querySelector("[data-mockup]")).not.toBeNull();
		expect(root.querySelector("section#comment")).not.toBeNull();
		expect(root.querySelector("section#formules")).not.toBeNull();
		expect(root.querySelector("footer.site-footer")).not.toBeNull();
		expect(root.querySelector("h1")?.textContent).toBe(
			LANDING_TEXT.fr.heroTitle,
		);
		// Le lien « Détail des formules » mène à /pricing/ dans la langue.
		const detail = [...root.querySelectorAll("a")].find(
			(a) => a.textContent === LANDING_TEXT.fr.plansDetail,
		);
		expect(detail?.getAttribute("href")).toBe("/pricing/?lang=fr");
		// Les étapes 2 et 3 montrent leurs pilules.
		const comment = root.querySelector("#comment");
		expect(comment?.textContent).toContain("Analyser");
		expect(comment?.textContent).toContain("Risque faible");
		expect(comment?.textContent).toContain("12/100");
	});

	it("pilule de l'étape 3 : le séparateur « · » se lit, sans CSS comme au lecteur d'écran", () => {
		for (const locale of LOCALES) {
			const root = monter(rendu(locale));
			const t = LANDING_TEXT[locale];
			const pilules = [...root.querySelectorAll("#comment .landing-chip")];
			const niveau = pilules.find((p) => p.textContent?.includes(t.stepScore));
			expect(niveau?.textContent).toBe(`${t.stepLevel} · ${t.stepScore}`);
			const separateur = niveau?.querySelector(".landing-chip__sep");
			expect(separateur?.textContent).toBe(" · ");
			expect(separateur?.hasAttribute("aria-hidden")).toBe(false);
		}
	});

	it("NL : « Betalen kan binnenkort. » et « Formules in detail »", () => {
		expect(LANDING_TEXT.nl.paymentSoon).toBe("Betalen kan binnenkort.");
		expect(LANDING_TEXT.nl.plansDetail).toBe("Formules in detail");
		const html = rendu("nl");
		expect(contient(html, "Betalen kan binnenkort.")).toBe(true);
		expect(contient(html, "Formules in detail")).toBe(true);
	});
});

describe("renderLanding : formules de secours", () => {
	it("formules de secours : prix et lignes de PLANS (ligne des icônes selon cardIcons), « Pas de photo analysée » pour 0 photo", () => {
		for (const locale of LOCALES) {
			const root = monter(rendu(locale));
			const t = PRICING[locale];
			const panneaux = [...root.querySelectorAll("[data-plan]")];
			expect(panneaux.map((p) => p.getAttribute("data-plan"))).toEqual([
				"trial",
				"standard",
				"premium",
			]);
			for (const key of ["trial", "standard", "premium"] as const) {
				const panneau = root.querySelector(`[data-plan="${key}"]`);
				const plan = PLANS[key];
				const prix = panneau?.querySelector('[data-field="price"]');
				expect(prix?.textContent).toBe(
					formatCents(plan.monthlyCents ?? 0, locale),
				);
				const lignes = [
					...(panneau?.querySelectorAll('[data-field="features"] li') ?? []),
				].map((li) => li.textContent);
				expect(lignes).toEqual(
					featureLines(
						t.plans[key],
						plan,
						locale,
						key === "trial" ? "scansTotal" : "scansMonth",
					),
				);
				expect(lignes.includes(t.plans[key].features.icons)).toBe(
					plan.cardIcons,
				);
				// Chaque valeur porte son data-field (rempli plus tard par l'offre en cours).
				expect(panneau?.querySelector('[data-field="name"]')?.textContent).toBe(
					t.plans[key].name,
				);
				expect(
					panneau?.querySelector('[data-field="tagline"]')?.textContent,
				).toBe(t.plans[key].tagline);
			}
			// Badge « Gratuit » sur l'essai seulement ; « / mois » sur les plans payants.
			expect(root.querySelector('[data-plan="trial"]')?.textContent).toContain(
				LANDING_TEXT[locale].freeBadge,
			);
			expect(
				root.querySelector('[data-plan="standard"]')?.textContent,
			).toContain(LANDING_TEXT[locale].perMonth);
			expect(root.querySelector('[data-plan="standard"]')?.className).toContain(
				"featured",
			);
		}
	});

	it("« Pas de photo analysée » pour 0 photo, pas d'icônes sans cardIcons, aucun « undefined »", () => {
		const offre: Offer = {
			...PLANS,
			premium: { ...PLANS.premium, maxImages: 0, cardIcons: false },
		};
		const html = rendu("fr", STORE, offre);
		const root = monter(html);
		const lignes = [
			...root.querySelectorAll(
				'[data-plan="premium"] [data-field="features"] li',
			),
		].map((li) => li.textContent);
		expect(lignes).toContain("Pas de photo analysée");
		expect(lignes).not.toContain(PRICING.fr.plans.premium.features.icons);
		expect(lignes).toContain(
			fill(PRICING.fr.plans.premium.features.scansMonth ?? "", { scans: 300 }),
		);
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("null");
	});
});

describe("renderLanding : installation", () => {
	it('installation : storeUrl → lien ; null → « Bientôt disponible », sans href, aria-disabled="true"', () => {
		const avec = monter(rendu("fr", STORE));
		const liens = [...avec.querySelectorAll("[data-install]")];
		expect(liens).toHaveLength(2);
		for (const lien of liens) {
			expect(lien.tagName).toBe("A");
			expect(lien.getAttribute("href")).toBe(STORE);
			expect(lien.textContent).toBe("Ajouter à Chrome, c'est gratuit");
			expect(lien.hasAttribute("aria-disabled")).toBe(false);
		}

		for (const [locale, texte] of [
			["fr", "Bientôt disponible"],
			["nl", "Binnenkort beschikbaar"],
		] as const) {
			const sans = monter(rendu(locale, null));
			const pilules = [...sans.querySelectorAll("[data-install]")];
			expect(pilules).toHaveLength(2);
			for (const pilule of pilules) {
				expect(pilule.tagName).not.toBe("A");
				expect(pilule.hasAttribute("href")).toBe(false);
				expect(pilule.getAttribute("aria-disabled")).toBe("true");
				expect(pilule.textContent).toBe(texte);
			}
		}
	});
});

describe("renderLanding : apparitions", () => {
	it("data-reveal présent sur les blocs, absent du hero", () => {
		const root = monter(rendu("fr"));
		const hero = root.querySelector(".landing-hero");
		expect(hero).not.toBeNull();
		expect(hero?.querySelector("[data-reveal]")).toBeNull();
		expect(hero?.hasAttribute("data-reveal")).toBe(false);
		// Bénéfices, titres, étapes, panneaux et pilule d'installation.
		const blocs = [...root.querySelectorAll("[data-reveal]")];
		expect(blocs.length).toBeGreaterThanOrEqual(12);
		for (const selecteur of [
			".landing-benefits [data-reveal]",
			"#comment h2[data-reveal]",
			"#comment [data-reveal] .landing-step__num",
			"#formules [data-plan][data-reveal]",
			".landing-install [data-install]",
		]) {
			expect(root.querySelector(selecteur), selecteur).not.toBeNull();
		}
		// Chaque bloc porte son rang (--i) pour l'écart de 60 ms.
		for (const bloc of blocs)
			expect(bloc.getAttribute("style")).toMatch(/^--i:\d+$/);
		// Les trois étapes se suivent : 0, 1, 2.
		const etapes = [...root.querySelectorAll("#comment .landing-step")];
		expect(etapes.map((e) => e.getAttribute("style"))).toEqual([
			"--i:0",
			"--i:1",
			"--i:2",
		]);
	});
});

describe("renderHead", () => {
	it("head : title ≤ 65 caractères par langue, canonical, trois hreflang absolus, og:image absolue par langue", () => {
		for (const locale of LOCALES) {
			document.head.innerHTML = renderHead(locale, PUBLIC);
			const head = document.head;
			const attr = (sel: string, name = "content") =>
				head.querySelector(sel)?.getAttribute(name);
			const titre = head.querySelector("title")?.textContent ?? "";
			expect(titre).toBe(LANDING_TEXT[locale].title);
			expect(titre.length).toBeGreaterThan(0);
			expect(titre.length).toBeLessThanOrEqual(65);
			expect(attr('meta[name="description"]')).toBe(
				LANDING_TEXT[locale].description,
			);
			expect(LANDING_TEXT[locale].description.length).toBeLessThanOrEqual(160);

			const page = locale === "fr" ? `${PUBLIC}/` : `${PUBLIC}/nl/`;
			expect(attr('link[rel="canonical"]', "href")).toBe(page);
			const alternates = Object.fromEntries(
				[...head.querySelectorAll('link[rel="alternate"]')].map((l) => [
					l.getAttribute("hreflang"),
					l.getAttribute("href"),
				]),
			);
			expect(alternates).toEqual({
				fr: `${PUBLIC}/`,
				nl: `${PUBLIC}/nl/`,
				"x-default": `${PUBLIC}/`,
			});

			expect(attr('meta[property="og:title"]')).toBeTruthy();
			expect(attr('meta[property="og:description"]')).toBeTruthy();
			expect(attr('meta[property="og:url"]')).toBe(page);
			expect(attr('meta[property="og:type"]')).toBe("website");
			expect(attr('meta[property="og:image"]')).toBe(
				`${PUBLIC}/og-${locale}.png`,
			);
			expect(attr('meta[property="og:image:width"]')).toBe("1200");
			expect(attr('meta[property="og:image:height"]')).toBe("630");
			expect(attr('meta[property="og:locale"]')).toBe(
				locale === "fr" ? "fr_BE" : "nl_BE",
			);
			expect(attr('meta[name="twitter:card"]')).toBe("summary_large_image");
			expect(attr('meta[name="twitter:image"]')).toBe(
				`${PUBLIC}/og-${locale}.png`,
			);
			expect(attr('link[rel="icon"][type="image/svg+xml"]', "href")).toBe(
				"/favicon.svg",
			);
			expect(attr('link[rel="apple-touch-icon"]', "href")).toBe(
				"/apple-touch-icon.png",
			);
		}
	});

	it("une origine avec une barre finale ne double pas la barre", () => {
		document.head.innerHTML = renderHead("nl", `${PUBLIC}/`);
		expect(
			document.head
				.querySelector('link[rel="canonical"]')
				?.getAttribute("href"),
		).toBe(`${PUBLIC}/nl/`);
	});

	it("les images Open Graph existent en 1200 × 630", () => {
		for (const locale of LOCALES) {
			const png = readFileSync(resolve(SITE, "public", `og-${locale}.png`));
			expect(png.subarray(1, 4).toString()).toBe("PNG");
			expect(png.readUInt32BE(16)).toBe(1200);
			expect(png.readUInt32BE(20)).toBe(630);
		}
	});
});

describe("landingPlugin", () => {
	/** Applique le hook transformIndexHtml du plugin à un gabarit du site. */
	async function transformer(
		gabarit: string,
		options: Parameters<typeof landingPlugin>[0],
	): Promise<string> {
		const plugin = landingPlugin(options);
		const hook = plugin.transformIndexHtml;
		const handler = typeof hook === "function" ? hook : hook?.handler;
		if (!handler) throw new Error("transformIndexHtml absent");
		const html = readFileSync(resolve(SITE, gabarit), "utf8");
		const sortie = await handler.call({} as never, html, {
			path: `/${gabarit}`,
			filename: resolve(SITE, gabarit),
		});
		if (typeof sortie !== "string") throw new Error("sortie inattendue");
		return sortie;
	}

	it("le build produit dist/index.html et dist/nl/index.html avec le texte dans le HTML", async () => {
		const fr = await transformer("index.html", {
			storeUrl: STORE,
			publicUrl: PUBLIC,
		});
		const nl = await transformer("nl/index.html", {
			storeUrl: STORE,
			publicUrl: PUBLIC,
		});
		expect(fr).toMatch(/<html lang="fr">/);
		expect(nl).toMatch(/<html lang="nl">/);
		expect(contient(fr, LANDING_TEXT.fr.heroTitle)).toBe(true);
		expect(contient(nl, LANDING_TEXT.nl.heroTitle)).toBe(true);
		expect(contient(fr, LANDING_TEXT.nl.heroTitle)).toBe(false);
		expect(contient(nl, LANDING_TEXT.fr.heroTitle)).toBe(false);
		for (const html of [fr, nl]) {
			expect(html).not.toContain("<!--landing:");
			expect(html).toContain(`href="${STORE}"`);
			expect(html.match(/<title>/g)).toHaveLength(1);
		}
		expect(fr).toContain(`<link rel="canonical" href="${PUBLIC}/">`);
		expect(nl).toContain(`<link rel="canonical" href="${PUBLIC}/nl/">`);
		// La feuille de style de la landing est déclarée par les deux gabarits.
		expect(fr).toContain("/src/landing/landing.css");
		expect(nl).toContain("/src/landing/landing.css");
		// Calque du dégradé en tête du corps, script de la page après le contenu.
		for (const html of [fr, nl]) {
			const sky = html.indexOf('<div class="sky" aria-hidden="true"></div>');
			const hero = html.indexOf('class="landing-hero"');
			const script = html.indexOf(
				'<script type="module" src="/src/landing/main.ts"></script>',
			);
			expect(sky).toBeGreaterThan(-1);
			expect(sky).toBeLessThan(hero);
			expect(script).toBeGreaterThan(html.indexOf('class="site-footer'));
		}
	});

	it("sans lien du store ni origine : « Bientôt disponible » et origine de repli", async () => {
		const fr = await transformer("index.html", {
			storeUrl: "",
			publicUrl: "",
		});
		expect(fr).toContain('aria-disabled="true"');
		expect(fr).toContain("Bientôt disponible");
		expect(fr).toContain(
			'<link rel="canonical" href="https://radarnaque.mostconsult.be/">',
		);
	});

	it("les autres pages ne sont pas touchées", async () => {
		const html = readFileSync(resolve(SITE, "pricing/index.html"), "utf8");
		const plugin = landingPlugin({ storeUrl: STORE, publicUrl: PUBLIC });
		const hook = plugin.transformIndexHtml;
		const handler = typeof hook === "function" ? hook : hook?.handler;
		const sortie = await handler?.call({} as never, html, {
			path: "/pricing/index.html",
			filename: resolve(SITE, "pricing/index.html"),
		});
		expect(sortie).toBe(html);
	});

	/** Applique le hook à un gabarit donné en texte, au chemin donné. */
	async function appliquer(html: string, path: string): Promise<unknown> {
		const plugin = landingPlugin({ storeUrl: STORE, publicUrl: PUBLIC });
		const hook = plugin.transformIndexHtml;
		const handler = typeof hook === "function" ? hook : hook?.handler;
		if (!handler) throw new Error("transformIndexHtml absent");
		return handler.call({} as never, html, {
			path,
			filename: resolve(SITE, path.slice(1)),
		});
	}

	it("échoue si un seul des deux marqueurs est présent", async () => {
		const tete = "<html><head><!--landing:head--></head><body></body></html>";
		const corps = "<html><head></head><body><!--landing:body--></body></html>";
		for (const path of ["/index.html", "/nl/index.html", "/autre/index.html"]) {
			await expect(appliquer(tete, path)).rejects.toThrow(/landing:body/);
			await expect(appliquer(corps, path)).rejects.toThrow(/landing:head/);
		}
	});

	it("échoue si /index.html ou /nl/index.html n'ont pas leurs marqueurs", async () => {
		const nu = "<html><head></head><body></body></html>";
		for (const path of ["/index.html", "/nl/index.html", "/nl/", "/"]) {
			await expect(appliquer(nu, path), path).rejects.toThrow(/marqueur/);
		}
		// Une autre page sans marqueur passe inchangée.
		expect(await appliquer(nu, "/pricing/index.html")).toBe(nu);
	});
});
