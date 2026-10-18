import { describe, expect, test, vi } from "vitest";
import {
	AI_RESULT_TTL_MS,
	createAiResultStore,
	listingFingerprint,
	MAX_AI_RESULTS,
	NO_REMAINING,
	type StorageAreaLike,
	type StoredAiEntry,
	type StoredAiResult,
} from "../lib/content/ai-results";
import type { Listing } from "../lib/listing/types";
import { sampleAnalysis } from "./helpers";

const ANALYZED_AT = Date.parse(sampleAnalysis.analyzedAt);

/** Stockage en mémoire, avec la valeur exposée pour les vérifications. */
function memoryArea(initial: Record<string, StoredAiEntry> = {}) {
	let value: Record<string, StoredAiEntry> = initial;
	const area = {
		getValue: vi.fn(async () => value),
		setValue: vi.fn(async (next: Record<string, StoredAiEntry>) => {
			value = next;
		}),
	} satisfies StorageAreaLike;
	return { area, value: () => value };
}

const entryOf = (
	storedAt: number,
	overrides: Partial<StoredAiResult> = {},
): StoredAiResult => ({
	result: sampleAnalysis,
	scanKind: "text",
	fingerprint: "fp",
	storedAt,
	...overrides,
});

/** L'entrée telle que le magasin la rend : sans quota restant. */
const stripped = (entry: StoredAiResult): StoredAiResult => ({
	...entry,
	result: { ...entry.result, remaining: NO_REMAINING },
});

const listing: Listing = {
	site: "2ememain.be",
	externalId: "m1",
	url: "https://www.2ememain.be/v/velo/m1",
	title: "Vélo",
	description: "Bon état.",
	price: { amountCents: 15000, currency: "EUR" },
	priceType: "fixed",
	location: { city: "Namur" },
	images: [],
	seller: { name: "Vendeur" },
};

describe("listingFingerprint", () => {
	test("JSON de titre, description, prix et type de prix, dans cet ordre", () => {
		expect(listingFingerprint(listing)).toBe(
			JSON.stringify({
				title: "Vélo",
				description: "Bon état.",
				price: { amountCents: 15000, currency: "EUR" },
				priceType: "fixed",
			}),
		);
	});

	test("prix absent : null ; vendeur et photos ignorés", () => {
		const a = listingFingerprint({ ...listing, price: null });
		expect(JSON.parse(a).price).toBeNull();
		expect(
			listingFingerprint({ ...listing, images: ["x"], seller: { name: "B" } }),
		).toBe(listingFingerprint(listing));
	});
});

describe("createAiResultStore : lecture et écriture", () => {
	test("put puis get : l'entrée est rendue dans son emplacement, sous site|externalId, v: 1", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const entry = entryOf(ANALYZED_AT);
		await store.put("2ememain.be", "m1", entry);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			text: stripped(entry),
		});
		expect(mem.value()).toEqual({
			"2ememain.be|m1": { v: 1, text: stripped(entry) },
		});
		expect(await store.get("2dehands.be", "m1")).toBeNull();
	});

	test("I1 : le quota restant n'est jamais stocké", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(mem.value()["2ememain.be|m1"]?.text?.result.remaining).toEqual({
			text: null,
			image: null,
			total: null,
		});
	});

	test("I1 : une ancienne entrée avec un quota est rendue sans quota", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": { v: 1, text: entryOf(ANALYZED_AT) },
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.text?.result.remaining).toEqual(NO_REMAINING);
	});

	test("R4 : une entrée par type ; texte et photos coexistent", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		const text = entryOf(ANALYZED_AT);
		const image = entryOf(ANALYZED_AT + 1, { scanKind: "image" });
		await store.put("2ememain.be", "m1", text);
		await store.put("2ememain.be", "m1", image);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			text: stripped(text),
			image: stripped(image),
		});
	});

	test("R4 : un nouveau scan texte remplace l'emplacement texte seulement", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		const image = entryOf(ANALYZED_AT, { scanKind: "image" });
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		await store.put("2ememain.be", "m1", image);
		const text2 = entryOf(ANALYZED_AT + 2, { fingerprint: "fp2" });
		await store.put("2ememain.be", "m1", text2);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			text: stripped(text2),
			image: stripped(image),
		});
	});

	test("entrée sans v: 1 (ancien format) : ignorée", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": entryOf(ANALYZED_AT) as unknown as StoredAiEntry,
			"2ememain.be|m2": { v: 2, text: entryOf(ANALYZED_AT) } as never,
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		expect(await store.get("2ememain.be", "m2")).toBeNull();
	});

	test("emplacement illisible ou d'un autre type : ignoré, l'autre reste", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": {
				v: 1,
				text: { result: null } as unknown as StoredAiResult,
				image: entryOf(ANALYZED_AT, { scanKind: "image" }),
			},
			"2ememain.be|m2": {
				v: 1,
				// Rangé dans `text` mais déclaré `image` : illisible.
				text: entryOf(ANALYZED_AT, { scanKind: "image" }),
			},
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			image: stripped(entryOf(ANALYZED_AT, { scanKind: "image" })),
		});
		expect(await store.get("2ememain.be", "m2")).toBeNull();
	});

	test("valeur stockée qui n'est pas un objet : get null, put la remplace", async () => {
		const mem = memoryArea("cassé" as unknown as Record<string, StoredAiEntry>);
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
	});

	test("un résultat partiel ne remplace jamais une analyse complète du même type", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		const full = entryOf(ANALYZED_AT);
		await store.put("2ememain.be", "m1", full);
		await store.put(
			"2ememain.be",
			"m1",
			entryOf(ANALYZED_AT + 1, {
				result: { ...sampleAnalysis, partial: true },
			}),
		);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			text: stripped(full),
		});
	});

	test("un partiel texte s'écrit à côté d'une analyse photos complète", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		const image = entryOf(ANALYZED_AT, { scanKind: "image" });
		await store.put("2ememain.be", "m1", image);
		const partial = entryOf(ANALYZED_AT + 1, {
			result: { ...sampleAnalysis, partial: true },
		});
		await store.put("2ememain.be", "m1", partial);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			text: stripped(partial),
			image: stripped(image),
		});
	});

	test("puts simultanés, mêmes et autres annonces : aucune écriture perdue", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await Promise.all([
			store.put("2ememain.be", "a", entryOf(ANALYZED_AT)),
			store.put(
				"2ememain.be",
				"a",
				entryOf(ANALYZED_AT, { scanKind: "image" }),
			),
			store.put("2ememain.be", "b", entryOf(ANALYZED_AT)),
			store.put("2ememain.be", "c", entryOf(ANALYZED_AT)),
		]);
		expect(Object.keys(mem.value()).sort()).toEqual([
			"2ememain.be|a",
			"2ememain.be|b",
			"2ememain.be|c",
		]);
		expect(Object.keys(mem.value()["2ememain.be|a"] ?? {}).sort()).toEqual([
			"image",
			"text",
			"v",
		]);
	});
});

describe("createAiResultStore : expiration", () => {
	test("get rend null après 24 h et une seconde, pas à 24 h pile", async () => {
		let clock = ANALYZED_AT;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		clock = ANALYZED_AT + AI_RESULT_TTL_MS;
		expect(await store.get("2ememain.be", "m1")).not.toBeNull();
		clock = ANALYZED_AT + AI_RESULT_TTL_MS + 1_000;
		expect(await store.get("2ememain.be", "m1")).toBeNull();
	});

	test("analysé il y a plus de 24 h (cache serveur), écrit à l'instant : expiré", async () => {
		const clock = ANALYZED_AT + AI_RESULT_TTL_MS + 1_000;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put("2ememain.be", "m1", entryOf(clock));
		expect(await store.get("2ememain.be", "m1")).toBeNull();
	});

	test("M4 : écrit il y a plus de 24 h, analyzedAt récent (horloge serveur en avance) : expiré", async () => {
		const clock = ANALYZED_AT + 1_000;
		const store = createAiResultStore(
			memoryArea({
				"2ememain.be|m1": {
					v: 1,
					text: entryOf(clock - AI_RESULT_TTL_MS - 1_000),
				},
			}).area,
			() => clock,
		);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
	});

	test("analyzedAt illisible : l'expiration part de storedAt", async () => {
		let clock = 5_000;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put(
			"2ememain.be",
			"m1",
			entryOf(5_000, { result: { ...sampleAnalysis, analyzedAt: "???" } }),
		);
		clock = 5_000 + AI_RESULT_TTL_MS;
		expect(await store.get("2ememain.be", "m1")).not.toBeNull();
		clock += 1_000;
		expect(await store.get("2ememain.be", "m1")).toBeNull();
	});

	test("chaque emplacement expire seul : photos expirées, texte rendu", async () => {
		const clock = ANALYZED_AT + AI_RESULT_TTL_MS + 1_000;
		const text = entryOf(clock, {
			result: { ...sampleAnalysis, analyzedAt: new Date(clock).toISOString() },
		});
		const store = createAiResultStore(
			memoryArea({
				"2ememain.be|m1": {
					v: 1,
					text,
					image: entryOf(ANALYZED_AT, { scanKind: "image" }),
				},
			}).area,
			() => clock,
		);
		expect(await store.get("2ememain.be", "m1")).toEqual({
			text: stripped(text),
		});
	});

	test("put retire les entrées expirées et celles d'un ancien format", async () => {
		const old = entryOf(1, {
			result: { ...sampleAnalysis, analyzedAt: "2026-10-01T00:00:00Z" },
		});
		const mem = memoryArea({
			"2ememain.be|old": { v: 1, text: old },
			"2ememain.be|v0": entryOf(ANALYZED_AT) as unknown as StoredAiEntry,
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
	});

	test("au-delà de 200 annonces, put retire les plus anciennes (storedAt le plus récent des emplacements)", async () => {
		const initial: Record<string, StoredAiEntry> = {};
		for (let i = 0; i < MAX_AI_RESULTS; i++)
			initial[`2ememain.be|m${i}`] = { v: 1, text: entryOf(ANALYZED_AT + i) };
		// m0 a le texte le plus ancien, mais des photos récentes : il reste.
		initial["2ememain.be|m0"] = {
			v: 1,
			text: entryOf(ANALYZED_AT),
			image: entryOf(ANALYZED_AT + 500, { scanKind: "image" }),
		};
		const mem = memoryArea(initial);
		const store = createAiResultStore(mem.area, () => ANALYZED_AT + 1_000);
		await store.put("2ememain.be", "new", entryOf(ANALYZED_AT + 1_000));
		const keys = Object.keys(mem.value());
		expect(keys).toHaveLength(MAX_AI_RESULTS);
		expect(keys).toContain("2ememain.be|new");
		expect(keys).toContain("2ememain.be|m0");
		expect(keys).not.toContain("2ememain.be|m1");
		expect(keys).toContain("2ememain.be|m2");
	});

	test("M1 : prune retire les entrées expirées et écrit une fois", async () => {
		const old = entryOf(1, {
			result: { ...sampleAnalysis, analyzedAt: "2026-10-01T00:00:00Z" },
		});
		const fresh = entryOf(ANALYZED_AT);
		const mem = memoryArea({
			"2ememain.be|old": { v: 1, text: old },
			"2ememain.be|m1": {
				v: 1,
				text: fresh,
				image: { ...old, scanKind: "image" },
			},
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.prune();
		expect(mem.area.setValue).toHaveBeenCalledTimes(1);
		expect(mem.value()).toEqual({ "2ememain.be|m1": { v: 1, text: fresh } });
	});

	test("M1 : prune sans entrée expirée n'écrit rien", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": { v: 1, text: entryOf(ANALYZED_AT) },
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.prune();
		expect(mem.area.setValue).not.toHaveBeenCalled();
	});
});

describe("createAiResultStore : copie en mémoire (M2)", () => {
	test("N lectures : une seule lecture du stockage", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": { v: 1, text: entryOf(ANALYZED_AT) },
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await Promise.all(
			["m1", "m2", "m3", "m4"].map((id) => store.get("2ememain.be", id)),
		);
		await store.get("2ememain.be", "m1");
		expect(mem.area.getValue).toHaveBeenCalledTimes(1);
	});

	test("put met la copie à jour : la lecture suivante voit l'entrée sans relire", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.get("2ememain.be", "m1");
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		const reads = mem.area.getValue.mock.calls.length;
		expect(await store.get("2ememain.be", "m1")).not.toBeNull();
		expect(mem.area.getValue).toHaveBeenCalledTimes(reads);
	});

	test("put relit le stockage : une entrée écrite par un autre onglet n'est pas perdue", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.get("2ememain.be", "x");
		// Un autre onglet écrit après la lecture mise en mémoire.
		await mem.area.setValue({
			"2ememain.be|other": { v: 1, text: entryOf(ANALYZED_AT) },
		});
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value()).sort()).toEqual([
			"2ememain.be|m1",
			"2ememain.be|other",
		]);
	});
});

describe("createAiResultStore : stockage indisponible", () => {
	test("stockage qui rejette : get donne null, put et prune résolvent, un seul log", async () => {
		const area: StorageAreaLike = {
			getValue: vi.fn(async () => {
				throw new Error("QUOTA_BYTES quota exceeded");
			}),
			setValue: vi.fn(async () => {
				throw new Error("QUOTA_BYTES quota exceeded");
			}),
		};
		const log = vi.fn();
		const store = createAiResultStore(area, () => ANALYZED_AT, log);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		await expect(
			store.put("2ememain.be", "m1", entryOf(ANALYZED_AT)),
		).resolves.toBeUndefined();
		await expect(store.prune()).resolves.toBeUndefined();
		await store.put("2ememain.be", "m2", entryOf(ANALYZED_AT));
		expect(log).toHaveBeenCalledTimes(1);
	});

	test("écriture qui rejette : put résout, la copie n'est pas faussée, les puts suivants ont lieu", async () => {
		const mem = memoryArea();
		mem.area.setValue.mockRejectedValueOnce(new Error("plein"));
		const store = createAiResultStore(mem.area, () => ANALYZED_AT, vi.fn());
		await expect(
			store.put("2ememain.be", "a", entryOf(ANALYZED_AT)),
		).resolves.toBeUndefined();
		expect(await store.get("2ememain.be", "a")).toBeNull();
		await store.put("2ememain.be", "b", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|b"]);
	});

	test("stockage par défaut (storage.local de WXT, clé local:aiResults)", async () => {
		const store = createAiResultStore(undefined, () => ANALYZED_AT);
		await store.put("facebook.com", "9", entryOf(ANALYZED_AT));
		expect(await store.get("facebook.com", "9")).toEqual({
			text: stripped(entryOf(ANALYZED_AT)),
		});
		const { storage } = await import("wxt/utils/storage");
		expect(
			await storage.getItem<Record<string, StoredAiEntry>>("local:aiResults"),
		).toHaveProperty(["facebook.com|9", "v"], 1);
	});
});
