import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_FACES } from "@radarnaque/design/fonts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFonts } from "../lib/content/fonts";
import { CONTENT_MATCHES } from "../lib/content/matches";

const url = (path: string) => `chrome-extension://test${path}`;

/** Ensemble de polices minimal : `loadFonts` n'utilise que `add`. */
function fakeSet() {
	const added: FontFace[] = [];
	const set = { add: (f: FontFace) => added.push(f) } as unknown as FontFaceSet;
	return { set, added };
}

type Created = {
	family: string;
	source: string;
	descriptors: FontFaceDescriptors;
};

function fakeCreate(load: () => Promise<unknown>) {
	const created: Created[] = [];
	const create = (
		family: string,
		source: string,
		descriptors: FontFaceDescriptors,
	) => {
		created.push({ family, source, descriptors });
		return { load } as unknown as FontFace;
	};
	return { create, created };
}

afterEach(() => vi.restoreAllMocks());

describe("loadFonts", () => {
	it("ajoute une FontFace par entrée, depuis l'extension", async () => {
		const { set, added } = fakeSet();
		const { create, created } = fakeCreate(() => Promise.resolve());
		await loadFonts(set, url, create);
		expect(added).toHaveLength(4);
		expect(created.map((c) => c.family)).toEqual(
			FONT_FACES.map((f) => f.family),
		);
		FONT_FACES.forEach((f, i) => {
			expect(created[i]?.source).toBe(
				`url("chrome-extension://test/fonts/${f.file}")`,
			);
			expect(created[i]?.descriptors).toMatchObject({
				weight: f.weight,
				unicodeRange: f.unicodeRange,
				display: "swap",
			});
		});
	});

	it("se résout sans exception quand load() rejette (CSP de la page)", async () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		const { set } = fakeSet();
		const { create } = fakeCreate(() => Promise.reject(new Error("CSP")));
		await expect(loadFonts(set, url, create)).resolves.toBeUndefined();
		expect(debug).toHaveBeenCalledTimes(1);
		expect(String(debug.mock.calls[0]?.[0])).toContain(
			"radarnaque: polices indisponibles",
		);
	});

	it("ne fait rien au second appel", async () => {
		const { set, added } = fakeSet();
		const { create } = fakeCreate(() => Promise.resolve());
		await loadFonts(set, url, create);
		await loadFonts(set, url, create);
		expect(added).toHaveLength(4);
	});
});

describe("manifeste", () => {
	it("expose les polices aux sites pris en charge", async () => {
		const config = (await import("../wxt.config")).default;
		const manifest = await (
			config.manifest as () => Promise<{
				web_accessible_resources?: unknown[];
			}>
		)();
		expect(manifest.web_accessible_resources).toContainEqual({
			resources: ["fonts/*.woff2"],
			matches: CONTENT_MATCHES,
		});
	});
});

describe("popup", () => {
	// `URL` est celui de happy-dom ici : chemin construit par node:path.
	const css = readFileSync(
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../entrypoints/popup/style.css",
		),
		"utf8",
	);
	const blocks = (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).map((b) =>
		b.replace(/\s+/g, " "),
	);
	const flat = (v: string) => v.replace(/\s+/g, "");

	it("lit les polices copiées dans /fonts/, sans importer fonts.css (pas de seconde copie)", () => {
		expect(css).not.toContain("@radarnaque/design/fonts.css");
		expect(blocks).toHaveLength(FONT_FACES.length);
		for (const f of FONT_FACES) {
			const block = blocks.find((b) =>
				b.includes(`url("/fonts/${f.file}") format("woff2")`),
			);
			expect(block, f.file).toBeDefined();
			expect(block).toContain(`font-family: "${f.family}"`);
			expect(block).toContain(`font-weight: ${f.weight}`);
			expect(block).toContain("font-display: swap");
			expect(block?.replace(/\s+/g, "")).toContain(
				`unicode-range:${flat(f.unicodeRange)}`,
			);
		}
	});

	it("déclare les deux familles", () => {
		const families = new Set(
			blocks.map((b) => /font-family: "([^"]+)"/.exec(b)?.[1]),
		);
		expect(families).toEqual(new Set(["Radarnaque Inter", "Radarnaque Serif"]));
	});
});
