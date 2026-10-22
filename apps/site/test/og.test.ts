import { describe, expect, it } from "vitest";
import { HEIGHT, HERO_STOPS, ogLayout, ogSvg } from "../scripts/og.ts";

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
