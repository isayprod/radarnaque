import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	HEIGHT,
	HERO_STOPS,
	isEntryPoint,
	ogLayout,
	ogSvg,
} from "../scripts/og.ts";

// L'écriture des PNG est espionnée : importer le module ne doit rien écrire.
const ecritures = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	writeFileSync: ecritures,
}));

const SCRIPT = resolve(import.meta.dirname, "../scripts/og.ts");

/** Fin du cobalt plein : dernier arrêt `--grad-1` avant le passage au bleu ciel. */
const cobaltEnd =
	Math.max(
		...HERO_STOPS.filter(([color]) => color === "#0649b8").map(([, at]) => at),
	) * HEIGHT;

describe("images Open Graph (scripts/og.ts)", () => {
	it.each(["fr", "nl"] as const)(
		"%s : titre et accroche entièrement sur le cobalt plein (pas à cheval sur le passage au bleu ciel)",
		(locale) => {
			const { taglineBottom, tagline } = ogLayout(locale);
			expect(tagline.length).toBeGreaterThan(0);
			expect(taglineBottom).toBeLessThan(cobaltEnd);
		},
	);

	it("dessine le titre et l'accroche de la langue, échappés", () => {
		const svg = ogSvg("fr");
		expect(svg).toContain("Radarnaque");
		expect(svg).toContain("Repérez");
		expect(svg).toContain("l&#39;arnaque");
		expect(svg).not.toContain("l'arnaque");
	});
});

describe("lancement du script (Node ≥ 24.0, sans import.meta.main)", () => {
	const url = pathToFileURL(SCRIPT).href;

	it("importé (tests) : aucune image écrite", () => {
		expect(ecritures).not.toHaveBeenCalled();
	});

	it("vrai seulement quand le module est le script lancé par node", () => {
		expect(isEntryPoint(SCRIPT, url)).toBe(true);
		expect(isEntryPoint(undefined, url)).toBe(false);
		expect(isEntryPoint(process.argv[1], url)).toBe(false);
		expect(isEntryPoint(resolve(import.meta.dirname, "og.test.ts"), url)).toBe(
			false,
		);
	});

	it("n'utilise plus import.meta.main (Node 24.2 et plus seulement)", () => {
		const source = readFileSync(SCRIPT, "utf8").replace(
			/\/\*[\s\S]*?\*\/|\/\/.*$/gm,
			"",
		);
		expect(source).not.toContain("import.meta.main");
	});
});
