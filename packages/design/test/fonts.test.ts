import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_FACES } from "../src/fonts.ts";

const css = readFileSync(new URL("../src/fonts.css", import.meta.url), "utf8");
const inFonts = (name: string) =>
	new URL(`../src/fonts/${name}`, import.meta.url);

describe("FONT_FACES", () => {
	it("compte quatre entrées", () => {
		expect(FONT_FACES).toHaveLength(4);
	});

	it("pointe vers des fichiers présents dans src/fonts", () => {
		for (const { file } of FONT_FACES) {
			expect(existsSync(inFonts(file)), file).toBe(true);
		}
	});

	it("a les poids attendus par famille", () => {
		for (const f of FONT_FACES) {
			expect(f.weight).toBe(
				f.family === "Radarnaque Inter" ? "400 600" : "400",
			);
		}
	});

	it("livre les deux licences", () => {
		expect(existsSync(inFonts("OFL-inter.txt"))).toBe(true);
		expect(existsSync(inFonts("OFL-instrument-serif.txt"))).toBe(true);
	});
});

describe("fonts.css", () => {
	it("déclare un @font-face par entrée, avec famille, plage et swap", () => {
		// Biome met la plage sur plusieurs lignes : on compare sans espaces.
		const blocks = (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).map((b) =>
			b.replace(/\s+/g, " "),
		);
		const flat = (v: string) => v.replace(/\s+/g, "");
		expect(blocks).toHaveLength(FONT_FACES.length);
		for (const f of FONT_FACES) {
			const block = blocks.find((b) => b.includes(`./fonts/${f.file}`));
			expect(block, f.file).toBeDefined();
			expect(block).toContain(`font-family: "${f.family}"`);
			expect(block?.replace(/\s+/g, "")).toContain(
				`unicode-range:${flat(f.unicodeRange)}`,
			);
			expect(block).toContain(`font-weight: ${f.weight}`);
			expect(block).toContain("font-display: swap");
			expect(block).toContain(`url("./fonts/${f.file}") format("woff2")`);
		}
	});
});
