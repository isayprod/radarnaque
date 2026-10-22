// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locale } from "@radarnaque/shared";
import { describe, expect, it } from "vitest";
import { toHtml } from "../src/h";
import { MOCKUP_TEXT, mockupNode } from "../src/landing/mockup";
import { renderLanding } from "../src/landing/render";
import { PLANS } from "../src/pages-i18n";

const SITE = resolve(import.meta.dirname, "..");
const CSS = readFileSync(resolve(SITE, "src/landing/mockup.css"), "utf8");
const LOCALES: Locale[] = ["fr", "nl"];

/** Monte la maquette d'une langue dans le document et renvoie sa racine. */
function monter(locale: Locale): HTMLElement {
	document.body.innerHTML = toHtml(mockupNode(locale));
	const root = document.body.firstElementChild;
	if (!(root instanceof HTMLElement)) throw new Error("maquette absente");
	return root;
}

/** Toutes les chaînes d'un objet de textes, en profondeur. */
function chaines(valeur: unknown): string[] {
	if (typeof valeur === "string") return [valeur];
	if (Array.isArray(valeur)) return valeur.flatMap(chaines);
	if (valeur && typeof valeur === "object")
		return Object.values(valeur).flatMap(chaines);
	return [];
}

describe("maquette du produit (spec landing §4)", () => {
	it("maquette : adresse en texte, aucun <img> ni URL vers 2ememain.be hors du texte de l'adresse, aucune image distante", () => {
		for (const locale of LOCALES) {
			const html = toHtml(mockupNode(locale));
			const root = monter(locale);
			// L'adresse est un texte dans la barre de la fenêtre.
			const adresse = root.querySelector(".mk-url");
			expect(adresse?.textContent).toBe(MOCKUP_TEXT[locale].address);
			// Aucune image ni ressource distante : ni <img>, ni <image>, ni src, ni href, ni url().
			expect(html).not.toMatch(/<img\b|<image\b|\ssrc=|\shref=|url\(/i);
			// Seule URL du HTML : l'espace de noms SVG.
			expect(
				html
					.match(/https?:\/\/[^\s"<]+/g)
					?.filter((url) => url !== "http://www.w3.org/2000/svg") ?? [],
			).toEqual([]);
			// « 2ememain.be » n'apparaît qu'une fois au plus, dans le texte de l'adresse.
			const occurrences = html.match(/2ememain\.be/g) ?? [];
			expect(occurrences.length).toBe(
				(adresse?.textContent ?? "").includes("2ememain.be") ? 1 : 0,
			);
			// Rien d'interactif : la maquette est une illustration.
			expect(
				root.querySelectorAll("a, button, input, textarea, select"),
			).toHaveLength(0);
			expect(root.getAttribute("role")).toBe("img");
			expect(root.getAttribute("aria-label")).toBe(MOCKUP_TEXT[locale].alt);
		}
		expect(MOCKUP_TEXT.fr.address).toBe(
			"www.2ememain.be/v/telephonie-mobile/…",
		);
		// En néerlandais, la fiche est celle de 2dehands (le même site, en Flandre).
		expect(MOCKUP_TEXT.nl.address).toMatch(/^www\.2dehands\.be\/v\//);
		// La feuille de style ne charge rien non plus.
		expect(CSS).not.toMatch(/url\(|@import/);
	});

	it("photo du produit : illustration SVG en ligne", () => {
		const root = monter("fr");
		const photo = root.querySelector(".mk-photo svg");
		expect(photo).not.toBeNull();
		expect(photo?.getAttribute("aria-hidden")).toBe("true");
		// Une illustration dessinée : des formes, aucune image incorporée.
		expect(
			photo?.querySelectorAll("rect, path, circle").length,
		).toBeGreaterThan(5);
		expect(
			root.querySelectorAll(".mk-thumbs svg").length,
		).toBeGreaterThanOrEqual(3);
		// Couleurs par classes (variables du bloc de mockup.css), jamais d'attribut fill brut.
		expect(toHtml(mockupNode("fr"))).not.toMatch(
			/(?:fill|stroke|stop-color)="#/,
		);
	});

	it("pastille et panneau : « Risque élevé », « 82 », trois raisons avec leurs badges de gravité", () => {
		const root = monter("fr");
		// La pastille suit le titre de l'annonce.
		const titre = root.querySelector(".mk-title");
		expect(titre?.textContent).toContain("iPhone 14 Pro 128 Go, comme neuf");
		const pastille = titre?.querySelector(".mk-pill");
		expect(pastille?.textContent).toBe("Risque élevé · 82/100");
		expect(pastille?.querySelector(".mk-dot--high")).not.toBeNull();

		const panneau = root.querySelector(".mk-panel");
		expect(panneau?.querySelector(".mk-panel__title")?.textContent).toBe(
			"Analyse Radarnaque",
		);
		expect(panneau?.querySelector(".mk-score__value")?.textContent).toBe("82");
		expect(panneau?.querySelector(".mk-score__max")?.textContent).toBe("/100");
		expect(panneau?.querySelector(".mk-verdict")?.textContent).toBe(
			"Risque élevé",
		);
		expect(
			panneau
				?.querySelector<HTMLElement>(".mk-bar__fill")
				?.getAttribute("style"),
		).toBe("width:82%");
		expect(panneau?.querySelector(".mk-summary")?.textContent).toBe(
			MOCKUP_TEXT.fr.summary,
		);
		const raisons = [...(panneau?.querySelectorAll(".mk-reasons li") ?? [])];
		expect(raisons).toHaveLength(3);
		expect(
			raisons.map((li) => [
				li.querySelector(".mk-sev")?.className,
				li.querySelector(".mk-sev")?.textContent,
			]),
		).toEqual([
			["mk-sev mk-sev--danger", "Grave"],
			["mk-sev mk-sev--warning", "Attention"],
			["mk-sev mk-sev--info", "Info"],
		]);
	});

	it("contenu fictif : prix, vendeur inscrit depuis 3 jours, paiement par lien dans la description", () => {
		const root = monter("fr");
		expect(root.querySelector(".mk-price")?.textContent).toBe(
			MOCKUP_TEXT.fr.price,
		);
		expect(root.querySelector(".mk-seller")?.textContent).toContain(
			"membre depuis 3 jours",
		);
		expect(root.querySelector(".mk-desc")?.textContent).toMatch(/lien/);
		expect(root.querySelector(".mk-search")).not.toBeNull();
		expect(
			root.querySelectorAll(".mk-crumbs li").length,
		).toBeGreaterThanOrEqual(3);
	});

	it("NL : textes de la maquette en néerlandais", () => {
		const root = monter("nl");
		expect(root.querySelector(".mk-pill")?.textContent).toBe(
			"Hoog risico · 82/100",
		);
		expect(root.querySelector(".mk-panel__title")?.textContent).toBe(
			"Radarnaque-analyse",
		);
		expect(
			[...root.querySelectorAll(".mk-sev")].map((badge) => badge.textContent),
		).toEqual(["Ernstig", "Let op", "Info"]);
		expect(root.querySelector(".mk-seller")?.textContent).toContain("3 dagen");
		// Aucun texte propre au français dans la maquette néerlandaise, et inversement.
		const fr = chaines(MOCKUP_TEXT.fr);
		const nl = chaines(MOCKUP_TEXT.nl);
		const propresFr = fr.filter((t) => !nl.some((n) => n.includes(t)));
		const propresNl = nl.filter((t) => !fr.some((f) => f.includes(t)));
		expect(propresFr.length).toBeGreaterThan(10);
		const htmlNl = root.textContent ?? "";
		for (const texte of propresFr) expect(htmlNl).not.toContain(texte);
		const htmlFr = monter("fr").textContent ?? "";
		for (const texte of propresNl) expect(htmlFr).not.toContain(texte);
	});

	it("la landing insère la maquette de sa langue dans son emplacement", () => {
		for (const locale of LOCALES) {
			document.body.innerHTML = renderLanding(locale, {
				offer: PLANS,
				storeUrl: null,
			});
			const place = document.querySelector("[data-mockup]");
			expect(place?.querySelector(".mk-panel")).not.toBeNull();
			expect(place?.textContent).toContain(MOCKUP_TEXT[locale].title);
		}
	});
});

describe("mockup.css", () => {
	const DEBUT = "couleurs du site tiers : début";
	const FIN = "couleurs du site tiers : fin";
	const COULEUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

	it("couleurs imitant le site tiers regroupées dans un seul bloc de variables commenté de mockup.css", () => {
		const lignes = CSS.split("\n");
		const debuts = lignes.flatMap((l, i) => (l.includes(DEBUT) ? [i] : []));
		const fins = lignes.flatMap((l, i) => (l.includes(FIN) ? [i] : []));
		expect(debuts).toHaveLength(1);
		expect(fins).toHaveLength(1);
		const [debut = 0] = debuts;
		const [fin = 0] = fins;
		expect(fin).toBeGreaterThan(debut);
		// Dans le bloc : seulement des variables --mk-…, des commentaires et des lignes vides.
		const bloc = lignes.slice(debut + 1, fin);
		const variables = bloc.filter((l) => /^\s*--mk-[a-z0-9-]+\s*:/.test(l));
		expect(variables.length).toBeGreaterThan(5);
		for (const ligne of bloc) {
			const vide = /^\s*$/.test(ligne);
			const commentaire = /^\s*(?:\/\*|\*)/.test(ligne);
			const variable =
				/^\s*--mk-[a-z0-9-]+:\s*[^;]+;\s*(?:\/\*.*\*\/)?\s*$/.test(ligne);
			expect(vide || commentaire || variable, ligne).toBe(true);
		}
		// Hors du bloc : aucune couleur brute.
		const dehors = [...lignes.slice(0, debut), ...lignes.slice(fin + 1)];
		expect(dehors.filter((l) => COULEUR.test(l))).toEqual([]);
	});

	it("flottement de 6 s et 4 px coupé sous mouvement réduit ; sous 768 px, plus de fenêtre", () => {
		expect(CSS).toMatch(/animation:\s*mk-float 6s/);
		expect(CSS).toMatch(/translateY\(-4px\)/);
		expect(CSS).toMatch(
			/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*animation:\s*none/,
		);
		expect(CSS).toMatch(/@media \(max-width: 767px\)/);
		const mobile = CSS.slice(CSS.indexOf("@media (max-width: 767px)"));
		expect(mobile).toMatch(/\.mk-chrome[^{]*\{[^}]*display:\s*none/);
	});
});
