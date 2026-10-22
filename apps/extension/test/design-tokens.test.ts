import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Garde-fou des tokens (spec du socle) : l'UI injectée ne prend ses couleurs que
 * dans les tokens de `@radarnaque/design` (utilités `bg-glass-host`,
 * `text-text-2`…), jamais une valeur en dur ni une couleur de la palette
 * Tailwind, et son `z-index` est 2 147 483 000, plus jamais le maximum.
 * La popup (`entrypoints/popup`) entre dans le parcours en partie 2.
 */

const COMPONENTS = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../components",
);

/** Fichiers parcourus : `components/*.tsx`, `components/*.ts` et `badge.css`. */
const FILES = readdirSync(COMPONENTS)
	.filter((name) => /\.tsx?$/.test(name) || name === "badge.css")
	.sort();

/** Exceptions admises (`fichier:ligne`) : aucune pour cette partie. */
const ALLOWED: ReadonlySet<string> = new Set();

/** Ce que le garde-fou refuse, avec la raison affichée en cas d'échec. */
const FORBIDDEN: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
	{
		reason: "couleur hexadécimale",
		pattern: /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi,
	},
	{ reason: "couleur rgb()/rgba()", pattern: /\brgba?\(/gi },
	{
		// Précédée d'un tiret (`bg-slate-800`, `hover:text-red-400`, `--brand-x`) :
		// `translate-` ou `stored-` ne sont pas des couleurs.
		reason: "couleur brute de Tailwind",
		pattern: /-(?:slate|gray|red|green|amber|emerald|brand)-/g,
	},
	{ reason: "z-index maximal", pattern: /2147483647/g },
];

/** Infractions d'un texte, ligne par ligne : `ligne: raison (extrait)`. */
function violations(source: string): string[] {
	const found: string[] = [];
	source.split("\n").forEach((line, index) => {
		for (const { reason, pattern } of FORBIDDEN) {
			for (const match of line.matchAll(pattern))
				found.push(`${index + 1}: ${reason} (${match[0]})`);
		}
	});
	return found;
}

describe("garde-fou des tokens", () => {
	test("parcourt les composants et badge.css", () => {
		expect(FILES).toContain("badge.css");
		expect(FILES).toContain("RiskBadge.tsx");
		expect(FILES).toContain("risk-styles.ts");
		expect(FILES.length).toBeGreaterThan(10);
	});

	test.each([
		["#fff", "couleur hexadécimale"],
		["color: #0649B8;", "couleur hexadécimale"],
		["0 0 #0000", "couleur hexadécimale"],
		["rgba(3, 16, 51, .9)", "couleur rgb()/rgba()"],
		["rgb(0 0 0)", "couleur rgb()/rgba()"],
		["bg-slate-800", "couleur brute de Tailwind"],
		["hover:text-red-400", "couleur brute de Tailwind"],
		["border-emerald-500/40", "couleur brute de Tailwind"],
		["text-brand-blue", "couleur brute de Tailwind"],
		["bg-gray-100", "couleur brute de Tailwind"],
		["z-[2147483647]", "z-index maximal"],
	])("repère %s", (sample, reason) => {
		expect(violations(sample).join("\n")).toContain(reason);
	});

	test.each([
		"hover:-translate-y-px",
		'key={"stored-" + index}',
		"bg-glass-host text-text-2 border-white/12",
		"bg-danger-soft text-danger",
		"z-[2147483000]",
		'href="#main"',
		"var(--gradient-hairline)",
	])("laisse passer %s", (sample) => {
		expect(violations(sample)).toEqual([]);
	});

	test.each(FILES)("%s n'utilise que des tokens", (name) => {
		const source = readFileSync(join(COMPONENTS, name), "utf8");
		const found = violations(source).filter(
			(entry) => !ALLOWED.has(`${name}:${entry.split(":")[0]}`),
		);
		expect(found).toEqual([]);
	});
});
