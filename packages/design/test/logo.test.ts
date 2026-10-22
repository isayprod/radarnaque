import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GRADIENT_COMPACT, iconTileSvg, LOGO, logoSvg } from "../src/logo.ts";

const tokens = readFileSync(
	new URL("../src/tokens.css", import.meta.url),
	"utf8",
);

describe("logoSvg", () => {
	const svg = logoSvg();

	it("dessine le point central et l'arc de 240 degrés sur une grille de 32", () => {
		expect(svg).toContain('viewBox="0 0 32 32"');
		expect(svg).toMatch(/<circle[^>]*r="4"/);
		const arc = svg.match(/<circle[^>]*pathLength="360"[^>]*>/)?.[0] ?? "";
		expect(arc).toContain('stroke-dasharray="240 120"');
		expect(arc).toContain('stroke-dashoffset="-15"');
		expect(arc).toContain('stroke-width="3.2"');
		expect(arc).toContain('stroke-linecap="round"');
	});

	it("reste en ligne, sans <use> ni transform, et sans classe d'animation", () => {
		expect(svg).not.toContain("<use");
		expect(svg).not.toContain("transform=");
		expect(svg).not.toContain("rq-logo--loading");
		expect(svg).toContain('aria-hidden="true"');
	});

	it("la version animée porte le groupe tournant et la classe de l'arc", () => {
		const animated = logoSvg({ animated: true });
		expect(animated).toContain("rq-logo--loading");
		expect(animated).toContain("rq-logo-spin");
		expect(animated).toContain("rq-logo-arc");
		expect(animated).not.toContain("transform=");
	});

	it("avec un label : role img et titre, sans aria-hidden, échappé", () => {
		const labelled = logoSvg({ label: "Radarnaque" });
		expect(labelled).toContain('role="img"');
		expect(labelled).toContain("<title>Radarnaque</title>");
		expect(labelled).not.toContain("aria-hidden");
		expect(logoSvg({ label: 'a<b>&"c' })).toContain(
			"<title>a&lt;b&gt;&amp;&quot;c</title>",
		);
	});

	it("applique la taille demandée", () => {
		expect(logoSvg({ size: 20 })).toContain('width="20"');
	});

	it("expose la géométrie", () => {
		expect(LOGO.center).toBe(16);
		expect(LOGO.dashArray).toBe("240 120");
	});
});

describe("iconTileSvg", () => {
	it("16 px : largeur 16, dégradé compact, logo à 75 %", () => {
		const svg = iconTileSvg(16);
		expect(svg).toContain('width="16"');
		for (const [color] of GRADIENT_COMPACT) expect(svg).toContain(color);
		// 16 * 0.75 / 32 = 0.375
		expect(svg).toContain("scale(0.375)");
		expect(svg).not.toContain("<use");
	});

	it("128 px : logo à 62 %", () => {
		// 128 * 0.62 / 32 = 2.48
		expect(iconTileSvg(128)).toContain("scale(2.48)");
	});
});

describe("GRADIENT_COMPACT", () => {
	it("copie les couleurs --grad-1, --grad-2 et --grad-3 de tokens.css", () => {
		const read = (name: string) =>
			tokens
				.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
				?.toLowerCase();
		expect(GRADIENT_COMPACT.map(([c]) => c)).toEqual([
			read("--grad-1"),
			read("--grad-2"),
			read("--grad-3"),
		]);
	});
});
