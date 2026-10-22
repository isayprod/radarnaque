import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
	readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const tokens = read("tokens.css");
const theme = read("theme.css");
const motion = read("motion.css");

describe("tokens.css", () => {
	it("déclare ses variables sur :root, :host", () => {
		expect(tokens).toMatch(/:root,\s*:host\s*\{/);
	});

	it("déclare les piles de polices", () => {
		const flat = tokens.replace(/\s+/g, " ");
		expect(flat).toContain('--font-sans: "Radarnaque Inter", system-ui');
		expect(flat).toContain('--font-serif: "Radarnaque Serif", Georgia');
	});
});

describe("theme.css", () => {
	it("est un bloc @theme inline, sans import de Tailwind", () => {
		expect(theme).toContain("@theme inline");
		expect(theme).not.toContain("@import");
	});

	it("ne référence que des variables définies dans tokens.css", () => {
		const used = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map(
			(m) => m[1] as string,
		);
		expect(used.length).toBeGreaterThan(20);
		for (const name of used)
			expect(tokens, name).toMatch(new RegExp(`${name}:`));
	});
});

describe("motion.css", () => {
	it("définit les images clés du trait, de la rotation et du reflet", () => {
		expect(motion).toMatch(/@keyframes rq-logo-tail/);
		expect(motion).toContain("240 120");
		expect(motion).toContain("24 336");
		expect(motion).toContain("-231");
		expect(motion).toMatch(/@keyframes rq-logo-rotate/);
		expect(motion).toContain("144deg");
		expect(motion).toMatch(/@keyframes rq-shimmer/);
		expect(motion).toContain("1.6s");
		expect(motion).toContain("2.2s");
	});

	it("centre la rotation sur le groupe", () => {
		expect(motion).toContain("transform-box: view-box");
		expect(motion).toContain("transform-origin: 16px 16px");
	});

	it("neutralise les animations sous prefers-reduced-motion", () => {
		const block = motion.slice(
			motion.indexOf("@media (prefers-reduced-motion: reduce)"),
		);
		expect(block).toContain("@media (prefers-reduced-motion: reduce)");
		expect(block).toContain(".rq-logo--loading .rq-logo-arc");
		expect(block).toContain(".rq-logo--loading .rq-logo-spin");
		expect(block).toContain(".rq-shimmer");
		expect(block).toContain("animation: none");
		expect(block).toContain("color: inherit");
		expect(block).toContain("background: none");
	});
});
