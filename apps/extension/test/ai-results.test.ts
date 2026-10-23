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
import { debugAnalysis, sampleAnalysis, sampleIdentification } from "./helpers";

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
	identification: null,
	identifiedByUser: false,
	fingerprint: "fp",
	storedAt,
	...overrides,
});

/** Valeur stockée sous `site|externalId` : l'entrée et `v: 3`. */
const v3 = (entry: StoredAiResult): StoredAiEntry => ({ v: 3, ...entry });

/** Ancienne entrée `v: 2` : l'analyse seule. */
const legacyV2 = (entry: StoredAiResult): StoredAiEntry =>
	({
		v: 2,
		result: entry.result,
		fingerprint: entry.fingerprint,
		storedAt: entry.storedAt,
	}) as unknown as StoredAiEntry;

/** L'entrée telle que le magasin la rend : sans quota restant. */
const stripped = (entry: StoredAiResult): StoredAiResult => ({
	...entry,
	result: entry.result && { ...entry.result, remaining: NO_REMAINING },
	identification: entry.identification && {
		...entry.identification,
		remaining: NO_REMAINING,
	},
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
	test("JSON de titre, description, prix, type de prix et caractéristiques, dans cet ordre", () => {
		expect(listingFingerprint(listing)).toBe(
			JSON.stringify({
				title: "Vélo",
				description: "Bon état.",
				price: { amountCents: 15000, currency: "EUR" },
				priceType: "fixed",
				attributes: [],
			}),
		);
	});

	test("une caractéristique modifiée (kilométrage) change l'empreinte", () => {
		const km = (value: string) =>
			listingFingerprint({
				...listing,
				attributes: [{ label: "Kilométrage", value }],
			});
		expect(km("155.562 km")).not.toBe(km("55.562 km"));
		expect(km("155.562 km")).not.toBe(listingFingerprint(listing));
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
	test("put puis get : une seule place par annonce, sous site|externalId, v: 3", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const entry = entryOf(ANALYZED_AT);
		await store.put("2ememain.be", "m1", entry);
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(entry));
		expect(mem.value()).toEqual({ "2ememain.be|m1": v3(stripped(entry)) });
		expect(await store.get("2dehands.be", "m1")).toBeNull();
	});

	test("un nouveau scan remplace la place de l'annonce", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		const next = entryOf(ANALYZED_AT + 2, {
			fingerprint: "fp2",
			result: { ...sampleAnalysis, score: 80, level: "high" },
		});
		await store.put("2ememain.be", "m1", next);
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(next));
	});

	test("I1 : le quota restant n'est jamais stocké", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(NO_REMAINING).toEqual({ scans: null });
		expect(mem.value()["2ememain.be|m1"]?.result?.remaining).toEqual({
			scans: null,
		});
	});

	test("I1 : une entrée stockée avec un quota est rendue sans quota", async () => {
		const mem = memoryArea({ "2ememain.be|m1": v3(entryOf(ANALYZED_AT)) });
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.result?.remaining).toEqual(NO_REMAINING);
	});

	test("le bloc debug (prompts, réponse brute) n'est jamais stocké ni rendu", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.put(
			"2ememain.be",
			"m1",
			entryOf(ANALYZED_AT, { result: debugAnalysis }),
		);
		const stored = mem.value()["2ememain.be|m1"]?.result;
		expect(stored).toBeDefined();
		expect(stored).not.toHaveProperty("debug");
		expect(JSON.stringify(mem.value())).not.toContain(
			"Tu analyses une annonce.",
		);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.result).not.toHaveProperty("debug");
		expect(got?.result?.summary).toEqual(debugAnalysis.summary);
	});

	test("une entrée stockée avec un bloc debug est rendue sans lui", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": v3(entryOf(ANALYZED_AT, { result: debugAnalysis })),
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.result).not.toHaveProperty("debug");
	});

	test("ancienne forme { v: 1, text, image } : get null, puis un put la remplace", async () => {
		const old = {
			v: 1,
			text: { ...entryOf(ANALYZED_AT), scanKind: "text" },
			image: { ...entryOf(ANALYZED_AT), scanKind: "image" },
		} as unknown as StoredAiEntry;
		const mem = memoryArea({ "2ememain.be|m1": old });
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		const entry = entryOf(ANALYZED_AT + 1);
		await store.put("2ememain.be", "m1", entry);
		expect(mem.value()).toEqual({ "2ememain.be|m1": v3(stripped(entry)) });
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(entry));
	});

	test("entrée sans v: 2 ni v: 3, ou illisible : ignorée", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": entryOf(ANALYZED_AT) as unknown as StoredAiEntry,
			"2ememain.be|m2": { ...v3(entryOf(ANALYZED_AT)), v: 4 } as never,
			"2ememain.be|m3": {
				v: 3,
				result: null,
				identification: null,
				identifiedByUser: false,
				fingerprint: "fp",
				storedAt: 1,
			} as unknown as StoredAiEntry,
			"2ememain.be|m4": {
				...v3(entryOf(ANALYZED_AT)),
				fingerprint: 1,
			} as never,
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		for (const id of ["m1", "m2", "m3", "m4"])
			expect(await store.get("2ememain.be", id)).toBeNull();
	});

	test("seuls les champs connus sont rendus", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": {
				...v3(entryOf(ANALYZED_AT)),
				scanKind: "text",
			} as StoredAiEntry,
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toEqual(
			stripped(entryOf(ANALYZED_AT)),
		);
	});

	test("valeur stockée qui n'est pas un objet : get null, put la remplace", async () => {
		const mem = memoryArea("cassé" as unknown as Record<string, StoredAiEntry>);
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
	});

	test("un résultat partiel ne remplace jamais une analyse complète", async () => {
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
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(full));
	});

	test("une analyse complète remplace un résultat partiel", async () => {
		const store = createAiResultStore(memoryArea().area, () => ANALYZED_AT);
		await store.put(
			"2ememain.be",
			"m1",
			entryOf(ANALYZED_AT, { result: { ...sampleAnalysis, partial: true } }),
		);
		const full = entryOf(ANALYZED_AT + 1);
		await store.put("2ememain.be", "m1", full);
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(full));
	});

	test("puts simultanés, mêmes et autres annonces : aucune écriture perdue", async () => {
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await Promise.all([
			store.put("2ememain.be", "a", entryOf(ANALYZED_AT)),
			store.put("2ememain.be", "a", entryOf(ANALYZED_AT, { fingerprint: "2" })),
			store.put("2ememain.be", "b", entryOf(ANALYZED_AT)),
			store.put("2ememain.be", "c", entryOf(ANALYZED_AT)),
		]);
		expect(Object.keys(mem.value()).sort()).toEqual([
			"2ememain.be|a",
			"2ememain.be|b",
			"2ememain.be|c",
		]);
		expect(mem.value()["2ememain.be|a"]?.fingerprint).toBe("2");
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
				"2ememain.be|m1": v3(entryOf(clock - AI_RESULT_TTL_MS - 1_000)),
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

	test("un partiel s'écrit à la place d'une analyse complète expirée", async () => {
		const clock = ANALYZED_AT + AI_RESULT_TTL_MS + 1_000;
		const mem = memoryArea({ "2ememain.be|m1": v3(entryOf(ANALYZED_AT)) });
		const store = createAiResultStore(mem.area, () => clock);
		const partial = entryOf(clock, {
			result: {
				...sampleAnalysis,
				partial: true,
				analyzedAt: new Date(clock).toISOString(),
			},
		});
		await store.put("2ememain.be", "m1", partial);
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(partial));
	});

	test("put retire les entrées expirées et celles d'une ancienne forme", async () => {
		const old = entryOf(1, {
			result: { ...sampleAnalysis, analyzedAt: "2026-10-01T00:00:00Z" },
		});
		const mem = memoryArea({
			"2ememain.be|old": v3(old),
			"2ememain.be|v1": { v: 1, text: entryOf(ANALYZED_AT) } as never,
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.put("2ememain.be", "m1", entryOf(ANALYZED_AT));
		expect(Object.keys(mem.value())).toEqual(["2ememain.be|m1"]);
	});

	test(`au-delà de ${MAX_AI_RESULTS} annonces, put retire les plus anciennes (storedAt)`, async () => {
		const initial: Record<string, StoredAiEntry> = {};
		for (let i = 0; i < MAX_AI_RESULTS; i++)
			initial[`2ememain.be|m${i}`] = v3(entryOf(ANALYZED_AT + i));
		// m0 a été réécrit récemment : il reste, m1 devient le plus ancien.
		initial["2ememain.be|m0"] = v3(entryOf(ANALYZED_AT + 500));
		const mem = memoryArea(initial);
		const store = createAiResultStore(mem.area, () => ANALYZED_AT + 1_000);
		await store.put("2ememain.be", "new", entryOf(ANALYZED_AT + 1_000));
		const keys = Object.keys(mem.value());
		expect(MAX_AI_RESULTS).toBe(200);
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
			"2ememain.be|old": v3(old),
			"2ememain.be|m1": v3(fresh),
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.prune();
		expect(mem.area.setValue).toHaveBeenCalledTimes(1);
		expect(mem.value()).toEqual({ "2ememain.be|m1": v3(fresh) });
	});

	test("M1 : prune sans entrée expirée n'écrit rien", async () => {
		const mem = memoryArea({ "2ememain.be|m1": v3(entryOf(ANALYZED_AT)) });
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		await store.prune();
		expect(mem.area.setValue).not.toHaveBeenCalled();
	});
});

describe("createAiResultStore : copie en mémoire (M2)", () => {
	test("N lectures : une seule lecture du stockage", async () => {
		const mem = memoryArea({ "2ememain.be|m1": v3(entryOf(ANALYZED_AT)) });
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
		await mem.area.setValue({ "2ememain.be|other": v3(entryOf(ANALYZED_AT)) });
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
		expect(await store.get("facebook.com", "9")).toEqual(
			stripped(entryOf(ANALYZED_AT)),
		);
		const { storage } = await import("wxt/utils/storage");
		expect(
			await storage.getItem<Record<string, StoredAiEntry>>("local:aiResults"),
		).toHaveProperty(["facebook.com|9", "v"], 3);
	});
});

const IDENTIFIED_AT = Date.parse(sampleIdentification.identifiedAt);
/** Analyse du même jour que l'identification : les deux expirent ensemble. */
const sameDay = {
	...sampleAnalysis,
	analyzedAt: sampleIdentification.identifiedAt,
};
const fullEntry = (storedAt: number, overrides = {}): StoredAiResult =>
	entryOf(storedAt, { result: sameDay, ...overrides });
const identOnly = (storedAt: number, overrides = {}): StoredAiResult =>
	entryOf(storedAt, {
		result: null,
		identification: sampleIdentification,
		identifiedByUser: true,
		...overrides,
	});

describe("createAiResultStore : identification", () => {
	test("reads a v2 entry as an analysis with its embedded identification", async () => {
		const result = { ...sampleAnalysis, identification: sampleIdentification };
		const mem = memoryArea({
			"2ememain.be|m1": legacyV2(entryOf(ANALYZED_AT, { result })),
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.result?.score).toBe(sampleAnalysis.score);
		expect(got?.identification?.identificationId).toBe(
			sampleIdentification.identificationId,
		);
		expect(got?.identifiedByUser).toBe(false);
		// Sans identification embarquée : null.
		mem.area.getValue.mockResolvedValueOnce({
			"2ememain.be|m2": legacyV2(entryOf(ANALYZED_AT)),
		});
		const other = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect((await other.get("2ememain.be", "m2"))?.identification).toBeNull();
	});

	test("identification-only entry round-trips", async () => {
		const mem = memoryArea();
		const clock = IDENTIFIED_AT;
		const store = createAiResultStore(mem.area, () => clock);
		const entry = identOnly(clock);
		await store.put("2ememain.be", "m1", entry);
		expect(await store.get("2ememain.be", "m1")).toEqual(stripped(entry));
		expect(mem.value()["2ememain.be|m1"]).toMatchObject({
			v: 3,
			result: null,
			identifiedByUser: true,
		});
	});

	test("put merges identification and analysis for the same fingerprint", async () => {
		const clock = IDENTIFIED_AT;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put("2ememain.be", "m1", identOnly(clock));
		await store.put("2ememain.be", "m1", fullEntry(clock));
		const both = await store.get("2ememain.be", "m1");
		expect(both?.result).not.toBeNull();
		expect(both?.identification).not.toBeNull();
		expect(both?.identifiedByUser).toBe(true);
		// L'inverse : une identification écrite après l'analyse la garde.
		await store.put("2ememain.be", "m2", fullEntry(clock));
		await store.put("2ememain.be", "m2", identOnly(clock));
		const inverse = await store.get("2ememain.be", "m2");
		expect(inverse?.result).not.toBeNull();
		expect(inverse?.identification).not.toBeNull();
	});

	test("put replaces the entry when the fingerprint changed", async () => {
		const clock = IDENTIFIED_AT;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put("2ememain.be", "m1", identOnly(clock));
		await store.put(
			"2ememain.be",
			"m1",
			fullEntry(clock, { fingerprint: "fp2" }),
		);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.identification).toBeNull();
		expect(got?.identifiedByUser).toBe(false);
		expect(got?.fingerprint).toBe("fp2");
	});

	test("expires 24 h after the oldest of analyzedAt and identifiedAt", async () => {
		const early = Date.parse("2026-10-23T08:00:00Z");
		const late = Date.parse("2026-10-23T12:00:00Z");
		const entry = entryOf(late, {
			result: { ...sampleAnalysis, analyzedAt: new Date(late).toISOString() },
			identification: {
				...sampleIdentification,
				identifiedAt: new Date(early).toISOString(),
			},
		});
		const mem = memoryArea({ "2ememain.be|m1": v3(entry) });
		let clock = early + AI_RESULT_TTL_MS;
		const store = createAiResultStore(mem.area, () => clock);
		expect(await store.get("2ememain.be", "m1")).not.toBeNull();
		clock += 1_000;
		const fresh = createAiResultStore(mem.area, () => clock);
		expect(await fresh.get("2ememain.be", "m1")).toBeNull();
	});

	test("an entry with neither result nor identification is dropped", async () => {
		const mem = memoryArea({
			"2ememain.be|m1": v3(
				entryOf(ANALYZED_AT, { result: null, identification: null }),
			),
		});
		const store = createAiResultStore(mem.area, () => ANALYZED_AT);
		expect(await store.get("2ememain.be", "m1")).toBeNull();
		await store.put(
			"2ememain.be",
			"m2",
			entryOf(ANALYZED_AT, { result: null, identification: null }),
		);
		expect(Object.keys(mem.value())).not.toContain("2ememain.be|m2");
	});

	test("identification remaining is never restored", async () => {
		const clock = IDENTIFIED_AT;
		const withQuota = {
			...sampleIdentification,
			remaining: { scans: 3 },
		};
		const mem = memoryArea({
			"2ememain.be|m1": v3(identOnly(clock, { identification: withQuota })),
		});
		const store = createAiResultStore(mem.area, () => clock);
		expect(
			(await store.get("2ememain.be", "m1"))?.identification?.remaining,
		).toEqual(NO_REMAINING);
		await store.put(
			"2ememain.be",
			"m2",
			identOnly(clock, { identification: withQuota }),
		);
		expect(mem.value()["2ememain.be|m2"]?.identification?.remaining).toEqual(
			NO_REMAINING,
		);
	});

	test("identifiedByUser survives a same-fingerprint analysis embedding an identification", async () => {
		const clock = IDENTIFIED_AT;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put("2ememain.be", "m1", identOnly(clock));
		await store.put(
			"2ememain.be",
			"m1",
			fullEntry(clock, {
				result: { ...sameDay, identification: sampleIdentification },
			}),
		);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.identifiedByUser).toBe(true);
		expect(got?.identification).not.toBeNull();
		expect(got?.result).not.toBeNull();
		// Autre empreinte : la valeur entrante.
		await store.put(
			"2ememain.be",
			"m1",
			fullEntry(clock, { fingerprint: "x" }),
		);
		expect((await store.get("2ememain.be", "m1"))?.identifiedByUser).toBe(
			false,
		);
	});

	test("a partial analysis adds an identification to a full one without replacing it", async () => {
		const clock = IDENTIFIED_AT;
		const store = createAiResultStore(memoryArea().area, () => clock);
		await store.put("2ememain.be", "m1", fullEntry(clock));
		await store.put(
			"2ememain.be",
			"m1",
			fullEntry(clock, {
				result: { ...sameDay, partial: true },
				identification: sampleIdentification,
				identifiedByUser: true,
			}),
		);
		const got = await store.get("2ememain.be", "m1");
		expect(got?.result?.partial).toBe(false);
		expect(got?.identification).not.toBeNull();
		expect(got?.identifiedByUser).toBe(true);
	});

	test("a partial analysis without identification over a full one writes nothing", async () => {
		const clock = IDENTIFIED_AT;
		const mem = memoryArea();
		const store = createAiResultStore(mem.area, () => clock);
		await store.put("2ememain.be", "m1", fullEntry(clock));
		const writes = mem.area.setValue.mock.calls.length;
		await store.put(
			"2ememain.be",
			"m1",
			fullEntry(clock + 5, { result: { ...sameDay, partial: true } }),
		);
		expect(mem.area.setValue).toHaveBeenCalledTimes(writes);
	});

	test("a garbage identification degrades to null (v2 and v3), dropped without analysis", async () => {
		const clock = IDENTIFIED_AT;
		const garbage = { identificationId: "x" };
		const base = fullEntry(clock);
		const mem = memoryArea({
			"2ememain.be|a": {
				...legacyV2(base),
				result: { ...sameDay, identification: garbage },
			} as never,
			"2ememain.be|b": {
				...v3(base),
				identification: garbage,
				identifiedByUser: true,
			} as never,
			"2ememain.be|c": {
				...v3(identOnly(clock)),
				identification: garbage,
			} as never,
		});
		const store = createAiResultStore(mem.area, () => clock);
		for (const id of ["a", "b"]) {
			const got = await store.get("2ememain.be", id);
			expect(got?.result).not.toBeNull();
			expect(got?.identification).toBeNull();
			expect(got?.identifiedByUser).toBe(false);
		}
		expect(await store.get("2ememain.be", "c")).toBeNull();
	});
});
