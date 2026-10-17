import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadFixture } from "./helpers";

/**
 * Garde-fou de confidentialité : le dépôt est public, les fixtures viennent de
 * pages réelles. Aucun jeton, aucune donnée du visiteur, aucune vraie valeur
 * personnelle ne doit y entrer (voir test/fixtures/README.md).
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(TEST_DIR, "fixtures");
/** Liste locale des vraies valeurs (non commitée, absente en CI). */
const DENYLIST_PATH = resolve(TEST_DIR, "../../../web-pages/.denylist.txt");
const MAX_BYTES = 40 * 1024;

const FORBIDDEN_PATTERNS: Array<string | RegExp> = [
	"DTSGInit",
	'"LSD"',
	"jazoest",
	"fb_dtsg",
	"xsrf",
	"__user=",
	'"USER_ID"',
	"encryptedUserId",
	"fingerPrint",
	"sha256_email",
	"scontent",
	"fbcdn.net",
	"chrome-extension://",
	"bis_",
	"latitude",
	"longitude",
	"__ENV_CONFIG__",
	"__HEADER_CONFIG__",
	"dataLayer",
	// `<script src`, y compris avec d'autres attributs avant `src`.
	/<script\b[^>]*\ssrc\s*=/i,
];

const EXPECTED_FIXTURES = [
	"twh/listing-fixed.html",
	"twh/listing-bidding-skeleton.html",
	"facebook/grid.html",
	"facebook/item-modal.html",
	"facebook/item-page.html",
	"README.md",
];

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sous 4 caractères, une valeur ne compte que hors d'un mot (faux positifs). */
const MIN_SUBSTRING_LENGTH = 4;

/**
 * Une valeur réelle, insensible à la casse : simple sous-chaîne dès 4 caractères
 * (attrape une valeur collée au texte voisin), bornes lettre/chiffre en dessous.
 */
function denylistMatcher(value: string): RegExp {
	const escaped = escapeRegExp(value);
	return value.length >= MIN_SUBSTRING_LENGTH
		? new RegExp(escaped, "iu")
		: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(entity, body: string) => {
			if (body.startsWith("#")) {
				const hex = body[1] === "x" || body[1] === "X";
				const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
				return Number.isNaN(code) ? entity : String.fromCodePoint(code);
			}
			return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
		},
	);
}

function decodePercent(text: string): string {
	return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
		try {
			return decodeURIComponent(run);
		} catch {
			return run;
		}
	});
}

/** `/`, `<` et `\/` des JSON embarqués. */
function decodeJsonEscapes(text: string): string {
	return text
		.replace(/\\u002F/gi, "/")
		.replace(/\\u003C/gi, "<")
		.replace(/\\\//g, "/");
}

/** Formes contrôlées : brute, échappements JSON, entités HTML et %-encodage décodés. */
function scannedForms(raw: string): string {
	const json = decodeJsonEscapes(raw);
	const html = decodeHtmlEntities(json);
	return [raw, json, html, decodePercent(html), decodePercent(raw)].join("\n");
}

function readDenylist(): Array<{ line: number; re: RegExp }> {
	if (!existsSync(DENYLIST_PATH)) return [];
	return readFileSync(DENYLIST_PATH, "utf8")
		.split(/\r?\n/)
		.map((value, i) => ({ value: value.trim(), line: i + 1 }))
		.filter(({ value }) => value.length > 0)
		.map(({ value, line }) => ({ line, re: denylistMatcher(value) }));
}

/** Motifs interdits trouvés dans `content` (messages sans valeur réelle). */
function findViolations(
	raw: string,
	denylist: Array<{ line: number; re: RegExp }>,
): string[] {
	const content = scannedForms(raw);
	const lower = content.toLowerCase();
	const violations: string[] = [];
	for (const pattern of FORBIDDEN_PATTERNS) {
		const hit =
			typeof pattern === "string"
				? lower.includes(pattern.toLowerCase())
				: pattern.test(content);
		if (hit) violations.push(`motif interdit ${String(pattern)}`);
	}
	for (const { line, re } of denylist) {
		// Le message ne cite que le numéro de ligne : jamais la vraie valeur.
		if (re.test(content))
			violations.push(`valeur de la denylist (ligne ${line})`);
	}
	return violations;
}

const files = listFiles(FIXTURES_DIR);
const denylist = readDenylist();

describe("hygiène des fixtures", () => {
	test("les fixtures attendues existent", () => {
		const present = files.map((f) => relative(FIXTURES_DIR, f));
		expect(present).toEqual(expect.arrayContaining(EXPECTED_FIXTURES));
	});

	test.each(files.map((f) => [relative(FIXTURES_DIR, f), f]))(
		"%s ne contient ni secret ni vraie donnée personnelle",
		(_name, path) => {
			expect(findViolations(readFileSync(path, "utf8"), denylist)).toEqual([]);
		},
	);

	test.each(files.map((f) => [relative(FIXTURES_DIR, f), f]))(
		"%s fait moins de 40 Ko",
		(_name, path) => {
			expect(statSync(path).size).toBeLessThan(MAX_BYTES);
		},
	);

	test("la denylist attrape une valeur collée, encodée ou en casse différente", () => {
		const list = [{ line: 1, re: denylistMatcher("Dupont") }];
		expect(findViolations("vendeur DUPONT", list)).toHaveLength(1);
		expect(findViolations("vendeurDupontel", list)).toHaveLength(1);
		const date = [{ line: 1, re: denylistMatcher("16 oct.") }];
		expect(findViolations("depuis16 oct. '26", date)).toHaveLength(1);
		expect(findViolations("Du&#112;ont", list)).toHaveLength(1);
		expect(findViolations("Du&#x70;ONT", list)).toHaveLength(1);
		expect(findViolations("?q=Du%70ont", list)).toHaveLength(1);
		expect(findViolations('"u":"\\u002Fu\\u002FDupont"', list)).toHaveLength(1);
		expect(findViolations("Dup&amp;ont", list)).toEqual([]);
		expect(findViolations('<script async src="x.js">', [])).toHaveLength(1);
	});

	test("une valeur de moins de 4 caractères ne compte que hors d'un mot", () => {
		const list = [{ line: 1, re: denylistMatcher("MAX") }];
		expect(findViolations("vendeur max.", list)).toHaveLength(1);
		expect(findViolations("maximum", list)).toEqual([]);
	});

	test.skipIf(!existsSync(DENYLIST_PATH))(
		"denylist chargée et non vide",
		() => {
			expect(denylist.length).toBeGreaterThan(0);
		},
	);
});

describe("loadFixture", () => {
	test("renvoie un Document analysé depuis test/fixtures", () => {
		const doc = loadFixture("twh/listing-fixed.html");
		expect(doc.documentElement.lang).toBe("fr");
		expect(
			doc.querySelector("#seller-sidebar-root header h1")?.textContent,
		).toBe("Iphone 14 PRO 128GB");
	});
});
