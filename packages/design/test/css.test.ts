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

	it("déclare le verre opaque des surfaces injectées dans les pages tierces", () => {
		expect(tokens).toContain("--glass-bg-host: rgba(3, 16, 51, 0.96);");
		expect(theme).toContain("--color-glass-host: var(--glass-bg-host);");
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

	it("rayons en sm, md, lg : jamais --radius-s, -m, -l (rounded-s et rounded-l sont des utilités logiques de Tailwind)", () => {
		for (const name of ["--radius-s:", "--radius-m:", "--radius-l:"])
			expect(theme, name).not.toContain(name);
		expect(theme).toContain("--radius-sm: var(--r-s);");
		expect(theme).toContain("--radius-md: var(--r-m);");
		expect(theme).toContain("--radius-lg: var(--r-l);");
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

	it("définit le squelette de chargement : --bg-3, reflet lent de 1,6 s", () => {
		const start = motion.indexOf(".rq-skeleton {");
		expect(start).toBeGreaterThan(-1);
		const rule = motion.slice(start, motion.indexOf("}", start));
		expect(rule).toContain("background-color: var(--bg-3)");
		expect(rule).toContain("rq-skeleton 1.6s");
		expect(motion).toMatch(/@keyframes rq-skeleton/);
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
		expect(block).toContain(".rq-skeleton");
		expect(block).toContain("animation: none");
		expect(block).toContain("color: inherit");
		expect(block).toContain("background: none");
		// Squelette immobile : la forme seule, sans le reflet.
		expect(block).toMatch(/\.rq-skeleton\s*\{\s*background-image: none;/);
	});
});
