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
