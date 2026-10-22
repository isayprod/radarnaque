// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contrastRatio } from "../src/landing/gradient";
import { fillOffer, startLanding, startReveal } from "../src/landing/main";
import { renderLanding } from "../src/landing/render";
import type { Offer } from "../src/offer";
import { formatCents, PLANS } from "../src/pages-i18n";

const CSS = readFileSync(
	resolve(import.meta.dirname, "../src/landing/landing.css"),
	"utf8",
);
const TOKENS = readFileSync(
	resolve(import.meta.dirname, "../../../packages/design/src/tokens.css"),
	"utf8",
);

/** Valeur d'une variable des tokens (`--bg-0: #020b2d;` → `#020b2d`). */
function token(nom: string): string {
	const m = new RegExp(`${nom}:\\s*([^;]+);`).exec(TOKENS);
	if (!m?.[1]) throw new Error(`token absent : ${nom}`);
	return m[1].trim();
}

/** Règles du CSS, sélecteur et déclarations ; les règles des `@media` gardent leur requête. */
function regles(
	css: string,
): { media: string; selector: string; body: string }[] {
	const sansCommentaires = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const out: { media: string; selector: string; body: string }[] = [];
	const lire = (texte: string, media: string) => {
		const re = /([^{}]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g;
		for (const m of texte.matchAll(re)) {
			const selector = (m[1] ?? "").trim();
			const body = m[2] ?? "";
			if (selector.startsWith("@media")) lire(body, selector);
			else if (!selector.startsWith("@")) out.push({ media, selector, body });
		}
	};
	lire(sansCommentaires, "");
	return out;
}

/** Monte la landing rendue au build (offre de secours) et renvoie le document. */
function monter(locale: "fr" | "nl" = "fr"): Document {
	document.documentElement.className = "";
	document.documentElement.lang = locale;
	document.body.innerHTML = renderLanding(locale, {
		offer: PLANS,
		storeUrl: null,
	});
	return document;
}

const plan = (over: Partial<Offer["standard"]> = {}) => ({
	scans: 150,
	maxImages: 1,
	cardIcons: false,
	monthlyCents: 299,
	yearlyCents: 2900,
	...over,
});

/** Offre de l'API, différente des valeurs de secours. */
const OFFRE: Offer = {
	trial: plan({
		scans: 5,
		maxImages: 0,
		cardIcons: false,
		monthlyCents: null,
		yearlyCents: null,
	}),
	standard: plan({ scans: 180, monthlyCents: 349 }),
	premium: plan({
		scans: 500,
		maxImages: 6,
		cardIcons: true,
		monthlyCents: 799,
	}),
};

const champ = (doc: Document, key: keyof Offer, field: string) =>
	doc.querySelector(`[data-plan="${key}"] [data-field="${field}"]`)
		?.textContent ?? null;

/** IntersectionObserver factice : on décide quand un élément entre. */
class FauxObservateur {
	static derniers: FauxObservateur[] = [];
	observes = new Set<Element>();
	options: IntersectionObserverInit | undefined;
	constructor(
		private readonly rappel: IntersectionObserverCallback,
		options?: IntersectionObserverInit,
	) {
		this.options = options;
		FauxObservateur.derniers.push(this);
	}
	observe(el: Element) {
		this.observes.add(el);
	}
	unobserve(el: Element) {
		this.observes.delete(el);
	}
	disconnect() {
		this.observes.clear();
	}
	/** Comme le navigateur : seul un élément observé est signalé. */
	entrer(el: Element, isIntersecting = true) {
		if (!this.observes.has(el)) return;
		this.rappel(
			[{ target: el, isIntersecting } as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}
}

beforeEach(() => {
	FauxObservateur.derniers = [];
	vi.stubGlobal("IntersectionObserver", FauxObservateur);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	document.documentElement.className = "";
});

describe("startReveal", () => {
	it("observe chaque bloc data-reveal au seuil 0,15 et ajoute is-visible une seule fois à l'entrée", () => {
		const doc = monter();
		const blocs = [...doc.querySelectorAll("[data-reveal]")];
		expect(blocs.length).toBeGreaterThan(5);
		startReveal(doc);
		const obs = FauxObservateur.derniers[0];
		expect(obs?.options?.threshold).toBe(0.15);
		expect(obs?.observes.size).toBe(blocs.length);
		const bloc = blocs[0] as HTMLElement;
		const ajout = vi.spyOn(bloc.classList, "add");
		obs?.entrer(bloc, false);
		expect(bloc.classList.contains("is-visible")).toBe(false);
		obs?.entrer(bloc);
		expect(bloc.classList.contains("is-visible")).toBe(true);
		// Une fois : l'élément n'est plus observé, une seconde entrée n'y touche pas.
		expect(obs?.observes.has(bloc)).toBe(false);
		obs?.entrer(bloc);
		expect(ajout).toHaveBeenCalledTimes(1);
	});

	it("n'observe jamais le hero", () => {
		const doc = monter();
		startReveal(doc);
		const hero = doc.querySelector(".landing-hero");
		for (const el of FauxObservateur.derniers[0]?.observes ?? [])
			expect(hero?.contains(el)).toBe(false);
	});

	it("sans IntersectionObserver : tout est rendu visible tout de suite", () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		const doc = monter();
		startReveal(doc);
		for (const el of doc.querySelectorAll("[data-reveal]"))
			expect(el.classList.contains("is-visible")).toBe(true);
	});

	it("l'arrêt déconnecte l'observateur", () => {
		const doc = monter();
		const arreter = startReveal(doc);
		arreter();
		expect(FauxObservateur.derniers[0]?.observes.size).toBe(0);
	});
});

describe("apparitions et fonds : CSS", () => {
	const toutes = regles(CSS);

	it("l'état caché (opacité 0) ne s'applique que sous html.js", () => {
		const cachees = toutes.filter(
			(r) =>
				r.selector.includes("[data-reveal]") && /opacity:\s*0\s*;/.test(r.body),
		);
		expect(cachees.length).toBeGreaterThan(0);
		for (const r of cachees)
			for (const sel of r.selector.split(","))
				expect(sel.trim(), sel).toMatch(/^html\.js\b/);
	});

	it("fondu et montée de 8 px, 320 ms, courbe d'entrée, 60 ms d'écart par --i", () => {
		const cachee = toutes.find(
			(r) => r.media === "" && /^html\.js \[data-reveal\]$/.test(r.selector),
		);
		expect(cachee?.body).toMatch(/translate:\s*0 8px/);
		const visible = toutes.find(
			(r) => r.media === "" && r.selector.includes("[data-reveal].is-visible"),
		);
		expect(visible?.body).toMatch(/var\(--dur-slow\)/);
		expect(visible?.body).toMatch(/var\(--ease-enter\)/);
		expect(visible?.body).toMatch(/calc\(var\(--i, 0\) \* 60ms\)/);
	});

	it("sous mouvement réduit : aucune transition ni montée", () => {
		const reduites = toutes.filter(
			(r) =>
				/prefers-reduced-motion:\s*reduce/.test(r.media) &&
				r.selector.includes("[data-reveal]"),
		);
		expect(reduites.length).toBeGreaterThan(0);
		const corps = reduites.map((r) => r.body).join("\n");
		expect(corps).toMatch(/transition:\s*none/);
		expect(corps).toMatch(/translate:\s*none/);
	});

	it("sans JavaScript : sections sur --bg-0 et hero sur son dégradé ; transparents seulement sous html.js", () => {
		const transparents = toutes.filter((r) =>
			/background(?:-color|-image)?:\s*(?:transparent|none)/.test(r.body),
		);
		for (const sel of [
			".landing-main",
			".landing-install",
			".site-footer",
			".landing-hero",
		]) {
			const regle = transparents.find((r) => r.selector.includes(sel));
			expect(regle?.selector, sel).toMatch(/^html\.js\b/);
		}
		const main = toutes.find((r) => r.selector === ".landing-main");
		expect(main?.body).toMatch(/background-color:\s*var\(--bg-0\)/);
		const hero = toutes.find((r) => r.selector === ".landing-hero");
		expect(hero?.body).toMatch(/var\(--grad-1\)/);
	});

	it("sous le hero, tant que --sky-mix < 1 : un fond où --text-2 garde 4,5:1 (fenêtres hautes)", () => {
		const sky = toutes.find((r) => r.selector === ".sky");
		const corps = (sky?.body ?? "").replace(/\s+/g, " ");
		// Fond sous le hero : --sky-below, résolu jusqu'au token.
		const below = /--sky-below:\s*var\((--[\w-]+)\)/.exec(corps)?.[1];
		expect(below).toBe("--bg-0");
		const couleur = token(below ?? "");
		expect(contrastRatio(token("--text-2"), couleur)).toBeGreaterThanOrEqual(
			4.5,
		);
		// Dernier arrêt du dégradé : rien n'est peint après lui (tout le bas en --sky-below).
		const degrade = /linear-gradient\((.*)\);/.exec(corps)?.[1] ?? "";
		const arrets = degrade.split(/,(?![^(]*\))/).map((a) => a.trim());
		const dernier = arrets.at(-1) ?? "";
		expect(dernier).toMatch(/^var\(--sky-below\)/);
		// Atteint --sky-fade sous le bas du hero à --sky-mix = 0, repoussé au bas de la fenêtre à 1.
		expect(dernier).toContain(
			"(var(--hero-h) + var(--sky-fade)) * (1 - var(--sky-mix))",
		);
		expect(dernier).toMatch(/100% \* var\(--sky-mix\)/);
		// L'arrêt orange (--s5) finit au bas du hero : --sky-below n'est jamais l'orange.
		expect(arrets.at(-2)).toMatch(
			/^var\(--s5\) calc\(var\(--hero-h\) \* \(1 - var\(--sky-mix\)\)/,
		);
		// Fondu court : il reste sous la maquette, avant le premier texte.
		const fondu = /--sky-fade:\s*(\d+)px/.exec(corps)?.[1];
		expect(Number(fondu)).toBeGreaterThan(0);
		expect(Number(fondu)).toBeLessThanOrEqual(160);
	});

	it("calque fixe derrière la page, palette 0 par défaut", () => {
		const sky = toutes.find((r) => r.selector === ".sky");
		expect(sky?.body).toMatch(/position:\s*fixed/);
		expect(sky?.body).toMatch(/inset:\s*0/);
		expect(sky?.body).toMatch(/z-index:\s*-1/);
		for (let i = 1; i <= 5; i++)
			expect(sky?.body).toMatch(new RegExp(`--s${i}:\\s*var\\(--grad-${i}\\)`));
	});
});

describe("fillOffer", () => {
	it("écrit les valeurs de l'API dans les data-field des trois panneaux", () => {
		const doc = monter();
		fillOffer(doc, "fr", OFFRE);
		expect(champ(doc, "standard", "price")).toBe(formatCents(349, "fr"));
		expect(champ(doc, "premium", "price")).toBe(formatCents(799, "fr"));
		expect(champ(doc, "standard", "scans")).toContain("180");
		expect(champ(doc, "premium", "scans")).toContain("500");
		expect(champ(doc, "premium", "photos")).toContain("6");
		expect(champ(doc, "trial", "scans")).toContain("5");
		// Icônes : ligne présente seulement si le plan les a.
		expect(champ(doc, "premium", "icons")).not.toBeNull();
		expect(champ(doc, "standard", "icons")).toBeNull();
		expect(doc.body.textContent).not.toContain("undefined");
		expect(doc.body.textContent).not.toContain("NaN");
	});

	it("0 photo : « Pas de photo analysée » (NL : « Geen foto's geanalyseerd »)", () => {
		const fr = monter("fr");
		fillOffer(fr, "fr", OFFRE);
		expect(champ(fr, "trial", "photos")).toBe("Pas de photo analysée");
		const nl = monter("nl");
		fillOffer(nl, "nl", OFFRE);
		expect(champ(nl, "trial", "photos")).toBe("Geen foto's geanalyseerd");
	});

	it("garde le panneau, sa classe is-visible et son rang (pas de nouvel élément, pas de saut)", () => {
		const doc = monter();
		const panneau = doc.querySelector('[data-plan="standard"]');
		panneau?.classList.add("is-visible");
		fillOffer(doc, "fr", OFFRE);
		expect(doc.querySelector('[data-plan="standard"]')).toBe(panneau);
		expect(panneau?.classList.contains("is-visible")).toBe(true);
		expect(panneau?.getAttribute("style")).toBe("--i:1");
	});

	it.each([
		["null", null],
		["réponse invalide", { trial: { scans: "trois" } }],
		["plan manquant", { trial: PLANS.trial, standard: PLANS.standard }],
	])("%s : HTML inchangé (Review Focus 2)", (_nom, offre) => {
		const doc = monter();
		const avant = doc.body.innerHTML;
		fillOffer(doc, "fr", offre as unknown as Offer);
		expect(doc.body.innerHTML).toBe(avant);
	});
});

describe("startLanding", () => {
	it("pose html.js en premier, puis lance le dégradé, les apparitions et l'offre", async () => {
		const doc = monter();
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(OFFRE), { status: 200 }),
		);
		const classeAuDepart = vi.fn(() =>
			doc.documentElement.classList.contains("js"),
		);
		vi.stubGlobal(
			"IntersectionObserver",
			class extends FauxObservateur {
				constructor(rappel: IntersectionObserverCallback, o?: object) {
					classeAuDepart();
					super(rappel, o);
				}
			},
		);
		await startLanding(window, fetchImpl as unknown as typeof fetch);
		expect(doc.documentElement.classList.contains("js")).toBe(true);
		expect(classeAuDepart).toHaveReturnedWith(true);
		expect(fetchImpl).toHaveBeenCalledWith("/api/offer");
		expect(champ(doc, "standard", "price")).toBe(formatCents(349, "fr"));
		const sky = doc.querySelector<HTMLElement>(".sky");
		expect(sky).not.toBeNull();
	});

	it("API en panne : valeurs de secours gardées", async () => {
		const doc = monter();
		const avant = doc.querySelector("#formules")?.innerHTML;
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("réseau");
		});
		await startLanding(window, fetchImpl as unknown as typeof fetch);
		expect(doc.querySelector("#formules")?.innerHTML).toBe(avant);
	});

	it("langue lue sur <html lang> : NL", async () => {
		const doc = monter("nl");
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(OFFRE), { status: 200 }),
		);
		await startLanding(window, fetchImpl as unknown as typeof fetch);
		expect(champ(doc, "trial", "photos")).toBe("Geen foto's geanalyseerd");
	});
});
