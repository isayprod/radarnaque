import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Garde-fou des tokens du site (spec du socle §2.1 et §5) : les couleurs et les
 * tailles de police ne viennent que de `@radarnaque/design/tokens.css` (variables
 * `var(--…)`, tailles en `rem`), jamais d'une valeur brute.
 *
 * Fichiers parcourus : `src/**\/*.css`, `src/**\/*.ts` et les gabarits HTML.
 */

const SITE = resolve(import.meta.dirname, "..");

/** Fichiers d'un dossier et de ses sous-dossiers retenus par `keep`, relatifs au site. */
function walk(dir: string, keep: (name: string) => boolean): string[] {
	return readdirSync(join(SITE, dir), { withFileTypes: true }).flatMap(
		(entry) => {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) return walk(path, keep);
			return keep(entry.name) ? [path] : [];
		},
	);
}

const TEMPLATES = [
	"index.html",
	"nl/index.html",
	"pricing/index.html",
	"privacy/index.html",
	"auth/callback/index.html",
].filter((path) => existsSync(join(SITE, path)));

const FILES = [
	...walk("src", (name) => /\.(?:css|ts)$/.test(name)),
	...TEMPLATES,
].sort();

/**
 * Exceptions admises : une région d'un fichier, de la première ligne qui contient
 * `from` jusqu'à la première ligne suivante qui contient `to` (incluses). Un test
 * vérifie que chaque région existe, pour qu'une exception périmée ne reste pas.
 *
 * Seules exceptions prévues par le spec :
 * - tâche 5 : le bloc de variables commenté de `src/landing/mockup.css` (couleurs
 *   de la fiche 2ememain imitée, spec landing §4) ;
 * - tâche 6 : `PALETTE_KEYS` de `src/landing/gradient.ts` (palettes clés du
 *   dégradé au scroll, valeurs fixées par le spec landing §5.1).
 */
type Exception = {
	file: string;
	from: string;
	to: string;
	reason: string;
};
const ALLOWED: readonly Exception[] = [
	{
		file: "src/landing/mockup.css",
		from: "couleurs du site tiers : début",
		to: "couleurs du site tiers : fin",
		reason:
			"maquette de la landing : couleurs de la fiche 2ememain imitée et de sa photo dessinée (spec landing §4), regroupées dans un seul bloc de variables commenté",
	},
	{
		file: "src/landing/gradient.ts",
		from: "palettes clés : début",
		to: "palettes clés : fin",
		reason:
			"palettes clés du dégradé au scroll (spec landing §5.1) : interpolées en OKLab par le script, elles ne peuvent pas être des var(--…) ; la première reprend --grad-1 à --grad-5, les suivantes sont vérifiées au contraste par landing-gradient.test.ts",
	},
];

/** Ce que le garde-fou refuse, avec la raison affichée en cas d'échec. */
const FORBIDDEN: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
	{
		// Pas après `&` : une entité numérique (`&#160;`) n'est pas une couleur.
		reason: "couleur hexadécimale",
		pattern: /(?<!&)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi,
	},
	{ reason: "couleur rgb()/rgba()", pattern: /\brgba?\(/gi },
	{
		// `font-size: 14px`, `font: 500 13px/1.4 …`, `clamp(48px, …)`, `fontSize = "12px"`.
		reason: "taille de police en px",
		pattern: /\bfont(?:-size|Size)?\s*[:=][^;\n]*?\d(?:\.\d+)?px\b/gi,
	},
];

/** Lignes (numérotées à partir de 1) couvertes par les exceptions d'un fichier. */
function allowedLines(
	source: string,
	exceptions: readonly Pick<Exception, "from" | "to">[],
): Set<number> {
	const lines = source.split("\n");
	const allowed = new Set<number>();
	for (const { from, to } of exceptions) {
		const start = lines.findIndex((line) => line.includes(from));
		if (start === -1) continue;
		const end = lines.findIndex((line, i) => i >= start && line.includes(to));
		if (end === -1) continue;
		for (let i = start; i <= end; i++) allowed.add(i + 1);
	}
	return allowed;
}

/** Infractions d'un texte, ligne par ligne : `ligne: raison (extrait)`. */
function violations(
	source: string,
	exceptions: readonly Pick<Exception, "from" | "to">[] = [],
): string[] {
	const allowed = allowedLines(source, exceptions);
	const found: string[] = [];
	source.split("\n").forEach((line, index) => {
		if (allowed.has(index + 1)) return;
		for (const { reason, pattern } of FORBIDDEN) {
			for (const match of line.matchAll(pattern))
				found.push(`${index + 1}: ${reason} (${match[0]})`);
		}
	});
	return found;
}

describe("garde-fou des tokens du site", () => {
	test("parcourt les CSS et TS de src/, sous-dossiers compris, et les gabarits HTML", () => {
		expect(FILES).toEqual(
			expect.arrayContaining([
				"src/pages.css",
				"src/callback.css",
				"src/h.ts",
				"src/layout.ts",
				"src/pages-render.ts",
				"src/layout.css",
				"src/landing/landing.css",
				"src/landing/render.ts",
				"index.html",
				"nl/index.html",
				"pricing/index.html",
				"privacy/index.html",
				"auth/callback/index.html",
			]),
		);
		expect(FILES.some((f) => f.endsWith(".d.ts"))).toBe(true);
	});

	test.each([
		["#fff", "couleur hexadécimale"],
		["color: #0649B8;", "couleur hexadécimale"],
		["0 0 #0000", "couleur hexadécimale"],
		['"#020b2dcc"', "couleur hexadécimale"],
		["rgba(3, 16, 51, .9)", "couleur rgb()/rgba()"],
		["rgb(0 0 0)", "couleur rgb()/rgba()"],
		["background: RGB(1, 2, 3)", "couleur rgb()/rgba()"],
		["font-size: 14px;", "taille de police en px"],
		["font-size:13.5px", "taille de police en px"],
		["font-size: clamp(48px, 8vw, 104px);", "taille de police en px"],
		["font: 500 13px/1.4 var(--font-sans);", "taille de police en px"],
		['el.style.fontSize = "12px";', "taille de police en px"],
	])("repère %s", (sample, reason) => {
		expect(violations(sample).join("\n")).toContain(reason);
	});

	test.each([
		"color: var(--text-2);",
		"font-size: 0.875rem;",
		"font-size: clamp(3rem, 8vw, 6.5rem);",
		"font-family: var(--font-serif);",
		"font-weight: 500;",
		"padding: 16px 24px;",
		"border-radius: var(--r-m);",
		'href="#comment"',
		'href="/#formules"',
		"&#39;",
		"&#160;",
		"color-mix(in srgb, var(--accent) 45%, transparent)",
		"var(--gradient-compact)",
	])("laisse passer %s", (sample) => {
		expect(violations(sample)).toEqual([]);
	});

	test("une exception couvre sa seule région, de `from` à `to`", () => {
		const source = [
			"a { color: #fff; }",
			"/* couleurs tierces : début */",
			"--x: #123456;",
			"--y: rgb(1 2 3);",
			"/* couleurs tierces : fin */",
			"b { color: #000; }",
		].join("\n");
		const region = {
			from: "couleurs tierces : début",
			to: "couleurs tierces : fin",
		};
		expect(violations(source, [region])).toEqual([
			"1: couleur hexadécimale (#fff)",
			"6: couleur hexadécimale (#000)",
		]);
		expect(violations(source)).toHaveLength(4);
	});

	test("chaque exception est justifiée et désigne une région qui existe", () => {
		for (const exception of ALLOWED) {
			expect(exception.reason.length, exception.file).toBeGreaterThan(0);
			expect(FILES, exception.file).toContain(exception.file);
			const source = readFileSync(join(SITE, exception.file), "utf8");
			expect(
				allowedLines(source, [exception]).size,
				`${exception.file} : région ${exception.from} … ${exception.to}`,
			).toBeGreaterThan(0);
		}
	});

	test.each(FILES)("%s n'utilise que des tokens", (file) => {
		const source = readFileSync(join(SITE, file), "utf8");
		const mine = ALLOWED.filter((exception) => exception.file === file);
		expect(violations(source, mine)).toEqual([]);
	});
});
