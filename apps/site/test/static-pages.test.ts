// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../src/i18n";

const SITE = resolve(import.meta.dirname, "..");
const lire = (chemin: string) => readFileSync(resolve(SITE, chemin), "utf8");

const PAGES = [
	"pricing/index.html",
	"privacy/index.html",
	"auth/callback/index.html",
];

describe("favicon", () => {
	it.each(PAGES)(
		"%s déclare le favicon SVG, le PNG 32 et l'icône Apple",
		(page) => {
			const html = lire(page);
			expect(html).toContain(
				'<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
			);
			expect(html).toContain(
				'<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />',
			);
			expect(html).toContain(
				'<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
			);
		},
	);

	it.each([
		["favicon-32.png", 32],
		["apple-touch-icon.png", 180],
	])("public/%s est un PNG carré de %i px", (fichier, taille) => {
		const png = readFileSync(resolve(SITE, "public", fichier));
		expect(png.subarray(1, 4).toString()).toBe("PNG");
		expect(png.readUInt32BE(16)).toBe(taille);
		expect(png.readUInt32BE(20)).toBe(taille);
	});

	it("public/favicon.svg est la tuile du logo", () => {
		expect(existsSync(resolve(SITE, "public/favicon.svg"))).toBe(true);
		const svg = lire("public/favicon.svg");
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
		expect(svg).toContain("linearGradient");
		expect(svg).toContain('pathLength="360"');
	});
});

describe("/auth/callback", () => {
	afterEach(() => {
		vi.resetModules();
		document.body.replaceChildren();
	});

	it("plus de <style> en ligne ; panneau avec emplacement du logo et région de statut", () => {
		const html = lire("auth/callback/index.html");
		expect(html).not.toContain("<style");
		expect(html).not.toMatch(/\sstyle="/);
		expect(html).toContain('id="status" role="status" aria-live="polite"');
		expect(html).toContain("data-logo");
		expect(html).toContain(`>${MESSAGES.pending.fr}</p>`);
	});

	it("logo présent (animé pendant l'attente, fixe ensuite), messages inchangés", async () => {
		const html = lire("auth/callback/index.html");
		// Le corps de la page, sans sa balise <script> : le module est importé plus bas.
		document.body.innerHTML = (
			html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? ""
		).replace(/<script[\s\S]*?<\/script>/g, "");
		// La réponse de la route n'arrive qu'à la demande : l'attente reste observable.
		let repondre: (res: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						repondre = resolve;
					}),
			),
		);

		await import("../src/callback");
		const status = document.getElementById("status");
		const logo = () => document.querySelector("[data-logo] svg");
		expect(status?.textContent).toBe(MESSAGES.pending.fr);
		expect(logo()?.getAttribute("class")).toBe("rq-logo--loading");

		repondre(new Response("{}", { status: 401 }));
		await vi.waitFor(() =>
			expect(status?.textContent).toBe(MESSAGES.expired.fr),
		);
		expect(logo()).not.toBeNull();
		expect(logo()?.hasAttribute("class")).toBe(false);
		expect(document.querySelectorAll("[data-logo] svg")).toHaveLength(1);
	});

	it("les messages de la page restent ceux d'avant la passe design", () => {
		expect(MESSAGES).toEqual({
			pending: { fr: "Connexion en cours…", nl: "Bezig met verbinden…" },
			connected: {
				fr: "Connecté ✓ Vous pouvez fermer cet onglet.",
				nl: "Verbonden ✓ U kunt dit tabblad sluiten.",
			},
			expired: {
				fr: "Lien expiré ou déjà utilisé. Demandez un nouveau lien depuis l'extension.",
				nl: "Link verlopen of al gebruikt. Vraag een nieuwe link aan via de extensie.",
			},
			"no-extension": {
				fr: "Ouvrez ce lien dans le navigateur où Radarnaque est installé, ou saisissez le code reçu par email dans l'extension.",
				nl: "Open deze link in de browser waar Radarnaque geïnstalleerd is, of voer de code uit de e-mail in de extensie in.",
			},
		});
	});
});

describe("/privacy : largeur de lecture", () => {
	it("colonne en rem, 32rem au plus (45 à 70 caractères d'Inter par ligne, mesuré au navigateur), plus en ch", () => {
		const css = lire("src/pages.css");
		const regle = /\.page-main--prose\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
		const largeur = /max-width:\s*calc\((\d+(?:\.\d+)?)rem \+ 48px\)/.exec(
			regle,
		);
		expect(largeur, regle).not.toBeNull();
		expect(Number(largeur?.[1])).toBeLessThanOrEqual(32);
		expect(Number(largeur?.[1])).toBeGreaterThanOrEqual(24);
		expect(regle).not.toContain("ch");
	});
});
