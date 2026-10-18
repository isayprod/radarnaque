import { describe, expect, test, vi } from "vitest";
import {
	AI_RESULT_TTL_MS,
	createAiResultStore,
	listingFingerprint,
	MAX_AI_RESULTS,
	type StorageAreaLike,
	type StoredAiResult,
} from "../lib/content/ai-results";
import type { Listing } from "../lib/listing/types";
import { sampleAnalysis } from "./helpers";

const ANALYZED_AT = Date.parse(sampleAnalysis.analyzedAt);

/** Stockage en mémoire, avec la valeur exposée pour les vérifications. */
function memoryArea(initial: Record<string, StoredAiResult> = {}) {
	let value: Record<string, StoredAiResult> = initial;
	const area = {
		getValue: vi.fn(async () => value),
		setValue: vi.fn(async (next: Record<string, StoredAiResult>) => {
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

describe("createAiResultStore", () => {
	test("put puis get : l'entrée est rendue, sous la clé site|externalId", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const entry = entryOf(ANALYZED_AT);
		await store.put("2ememain.be", "m1", entry);
		expect(await store.get("2ememain.be", "m1")).toEqual(entry);
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
		expect(await store.get("2dehands.be", "m1")).toBeNull();
	});

	test("get rend null après 24 h et une seconde, pas à 24 h pile", async () => {
		let clock = ANALYZED_AT;
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => clock);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		clock = ANALYZED_AT + AI_RESULT_TTL_MS;
		expect(await store.get("2ememain.be", "m1")).not.toBeNull();
		clock = ANALYZED_AT + AI_RESULT_TTL_MS + 1_000;
		expect(await store.get("2ememain.be", "m1")).toBeNull();
	});

	test("l'expiration part de analyzedAt, pas du moment de l'écriture", async () => {
		const clock = ANALYZED_AT + AI_RESULT_TTL_MS + 1_000;
		const store = createAiResultStore(memoryArea().area, () => clock);
		// Écrit à l'instant (résultat venu du cache serveur), analysé il y a plus de 24 h.
		await store.put("2ememain.be", "m1", entryOf(clock));
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

	test("entrée illisible (forme inattendue) : null", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": { result: null } as unknown as StoredAiResult,
			"2ememain.be|m2": entryOf(1, {
				scanKind: "video" as unknown as "text",
			}),
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		expect(await store.get("2ememain.be", "m2")).toBeNull();
	});

	test("valeur stockée qui n'est pas un objet : get null, put la remplace", async () => {
		const mem = memoryArea(
			"cassé" as unknown as Record<string, StoredAiResult>,
		);
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
	});

	test("au-delà de 200 entrées, put retire les plus anciennes (storedAt)", async () => {
		const initial: Record<string, StoredAiResult> = {};
		for (let i = 0; i < MAX_AI_RESULTS; i++)
			initial[`2ememain.be|m${i}`] = entryOf(ANALYZED_AT + i);
		const mem = memoryArea(initial);
		const store = createAiResultStore(mem.area, () => ANALYZED_AT + 1_000);
		await store.put("2ememain.be", "new", entryOf(ANALYZED_AT + 1_000));
		const keys = Object.keys(mem.value());
		expect(keys).toHaveLength(MAX_AI_RESULTS);
		expect(keys).toContain("2ememain.be|new");
		expect(keys).not.toContain("2ememain.be|m0");
		expect(keys).toContain("2ememain.be|m1");
	});

	test("put retire les entrées expirées", async () => {
		const old = entryOf(1, {
			result: { ...sampleAnalysis, analyzedAt: "2026-10-01T00:00:00Z" },
		});
		const mem = memoryArea({ "2ememain.be|old": old });
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
	});

	test("puts simultanés : aucune écriture perdue", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await Promise.all([
			store.put("2ememain.be", "a", entryOf(ANALYZED_AT)),
			store.put("2ememain.be", "b", entryOf(ANALYZED_AT)),
			store.put("2ememain.be", "c", entryOf(ANALYZED_AT)),
		]);
		expect(Object.keys(mem.value()).sort()).toEqual([
			"2ememain.be|a",
			"2ememain.be|b",
			"2ememain.be|c",
		]);
	});

	test("la dernière analyse réussie remplace la précédente (image après texte)", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		const image = entryOf(ANALYZED_AT + 1, { scanKind: "image" });
		await store.put("2ememain.be", "m1", image);
		expect(await store.get("2ememain.be", "m1")).toEqual(image);
	});

	test("un résultat partiel ne remplace jamais une analyse complète non expirée", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		const full = entryOf(ANALYZED_AT, { scanKind: "image" });
		await store.put("2ememain.be", "m1", full);
		await store.put(
			"2ememain.be",
			"m1",
			entryOf(ANALYZED_AT + 1, {
				result: { ...sampleAnalysis, partial: true },
			}),
		);
		expect(await store.get("2ememain.be", "m1")).toEqual(full);
	});

	test("stockage qui rejette : get donne null, put résout, un seul log", async () => {
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
		await store.put("2ememain.be", "m2", entryOf(ANALYZED_AT));
		expect(log).toHaveBeenCalledTimes(1);
	});

	test("écriture qui rejette : put résout, et les puts suivants ont lieu", async () => {
		const mem = memoryArea();
		mem.area.setValue.mockRejectedValueOnce(new Error("plein"));
		const store = createAiResultStore(mem.area, () => ANALYZED_AT, vi.fn());
		await expect(
			store.put("2ememain.be", "a", entryOf(ANALYZED_AT)),
		).resolves.toBeUndefined();
		await store.put("2ememain.be", "b", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|b"]);
	});

	test("stockage par défaut (storage.local de WXT, clé local:aiResults)", async () => {
		const store = createAiResultStore(undefined, () => ANALYZED_AT);
		await store.put("facebook.com", "9", entryOf(ANALYZED_AT));
		expect(await store.get("facebook.com", "9")).toEqual(entryOf(ANALYZED_AT));
		const { storage } = await import("wxt/utils/storage");
		expect(
			await storage.getItem<Record<string, StoredAiResult>>("local:aiResults"),
		).toHaveProperty(["facebook.com|9"]);
	});
});
