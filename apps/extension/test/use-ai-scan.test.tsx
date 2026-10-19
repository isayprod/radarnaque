import type { AnalysisResult } from "@radarnaque/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
	ACTIVE_TTL_MS,
	type AccessCache,
	createAccessCache,
	RECHECK_MS,
} from "../lib/content/access-policy";
import type { AiClient } from "../lib/content/ai-client";
import {
	type AiResultStore,
	listingFingerprint,
	NO_REMAINING,
	type StoredAiResult,
	type StoredAiResults,
} from "../lib/content/ai-results";
import { type BadgeView, useAiScan } from "../lib/content/use-ai-scan";
import {
	createDebugLog,
	type DebugLog,
	type DebugSink,
} from "../lib/debug-log";
import type { Listing } from "../lib/listing/types";
import type { BgResponse, ContentAccess, ScanRequest } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";
import { debugAnalysis, sampleAnalysis } from "./helpers";

/** Promesse résolue de l'extérieur. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const ok = <T,>(data: T): BgResponse<T> => ({ ok: true, data });
const fail = (code: string): BgResponse<never> => ({
	ok: false,
	error: { code },
});

const active: ContentAccess = {
	status: "active",
	features: ["image_scan"],
	unlimited: false,
	debug: false,
	remaining: { text: 3, image: 3, total: null },
};

const report: RiskReport = {
	score: 35,
	level: "medium",
	rulesVersion: 2,
	signals: [{ id: "offsite_payment", weight: 35, severity: "danger" }],
};

function listingOf(externalId: string, overrides: Partial<Listing> = {}) {
	return {
		site: "2ememain.be",
		externalId,
		url: `https://www.2ememain.be/v/velo/${externalId}`,
		title: "Vélo",
		description: "Bon état.",
		price: { amountCents: 15000, currency: "EUR" },
		priceType: "fixed",
		location: { city: "Namur" },
		images: ["https://images.example/1.jpg"],
		seller: { name: "Vendeur", reviewCount: 4 },
		...overrides,
	} satisfies Listing;
}

const viewOf = (externalId: string): BadgeView => ({
	report,
	listing: listingOf(externalId),
});

/** Client simulé : chaque appel renvoie une promesse résolue depuis le test. */
function fakeClient() {
	const scans: Array<ReturnType<typeof deferred<BgResponse<AnalysisResult>>>> =
		[];
	const accesses: Array<
		ReturnType<typeof deferred<BgResponse<ContentAccess>>>
	> = [];
	const logins: Array<ReturnType<typeof deferred<BgResponse<null>>>> = [];
	const client = {
		access: vi.fn(() => {
			const d = deferred<BgResponse<ContentAccess>>();
			accesses.push(d);
			return d.promise;
		}),
		scan: vi.fn((_request: ScanRequest) => {
			const d = deferred<BgResponse<AnalysisResult>>();
			scans.push(d);
			return d.promise;
		}),
		openLogin: vi.fn(() => {
			const d = deferred<BgResponse<null>>();
			logins.push(d);
			return d.promise;
		}),
	} satisfies AiClient;
	return { client, scans, accesses, logins };
}

function setup(
	initial: BadgeView = viewOf("m1"),
	store?: AiResultStore,
	debugLog?: DebugLog,
) {
	const fake = fakeClient();
	let clock = 1_000;
	const cache: AccessCache = createAccessCache(() => clock);
	const hook = renderHook(
		({ view }: { view: BadgeView }) =>
			useAiScan(fake.client, view, "fr", cache, store, debugLog),
		{ initialProps: { view: initial } },
	);
	return {
		...fake,
		...hook,
		cache,
		advance(ms: number) {
			clock += ms;
		},
	};
}

/** Laisse les promesses déjà résolues propager leurs mises à jour d'état. */
const settle = () => act(async () => {});

describe("useAiScan : accès", () => {
	test("aucun appel avant loadAccess, puis un seul même si loadAccess est rappelé", async () => {
		const t = setup();
		expect(t.client.access).not.toHaveBeenCalled();
		expect(t.result.current.access).toBe("loading");

		act(() => t.result.current.loadAccess());
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(1);

		t.accesses[0]?.resolve(ok(active));
		await settle();
		expect(t.result.current.access).toEqual(active);
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(1);
	});

	test("accès en erreur : { error: code }", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(fail("background_unavailable"));
		await settle();
		expect(t.result.current.access).toEqual({
			error: "background_unavailable",
		});
	});

	test("réponses d'accès dans le désordre : seule la dernière demandée compte", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();

		// Deux scans terminés : deux relectures, qui répondent dans l'ordre inverse.
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		act(() => t.result.current.scan("image"));
		t.scans[1]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.access).toHaveBeenCalledTimes(3);

		const latest: ContentAccess = { status: "noSubscription" };
		t.accesses[2]?.resolve(ok(latest));
		await settle();
		t.accesses[1]?.resolve(ok(active));
		await settle();
		expect(t.result.current.access).toEqual(latest);
	});

	test("lecture en cours : loadAccess ne relance pas de lecture", () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(1);
	});

	test("signedOut : loadAccess relit, l'ancienne valeur reste affichée pendant la lecture", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok({ status: "signedOut" }));
		await settle();

		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(2);
		expect(t.result.current.access).toEqual({ status: "signedOut" });
		t.accesses[1]?.resolve(ok(active));
		await settle();
		expect(t.result.current.access).toEqual(active);
	});

	test.each([
		["en erreur", fail("background_unavailable")],
		["noSubscription", ok<ContentAccess>({ status: "noSubscription" })],
	])(
		"R8 : accès %s, loadAccess relit après 30 s, pas avant",
		async (_, first) => {
			const t = setup();
			act(() => t.result.current.loadAccess());
			t.accesses[0]?.resolve(first);
			await settle();
			t.advance(RECHECK_MS - 1);
			act(() => t.result.current.loadAccess());
			expect(t.client.access).toHaveBeenCalledTimes(1);
			t.advance(1);
			act(() => t.result.current.loadAccess());
			expect(t.client.access).toHaveBeenCalledTimes(2);
		},
	);

	test("R8 : accès actif, relu par loadAccess après 5 min seulement", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		t.advance(ACTIVE_TTL_MS - 1);
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(1);
		t.advance(1);
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(2);
		// L'accès reste affiché pendant la relecture.
		expect(t.result.current.access).toEqual(active);
	});

	test("R8 : cache partagé, un accès lu ailleurs (cartes) est affiché sans lecture", async () => {
		const t = setup();
		t.cache.settle(t.cache.begin(), active);
		act(() => t.result.current.loadAccess());
		expect(t.client.access).not.toHaveBeenCalled();
		expect(t.result.current.access).toEqual(active);
	});

	test("R8 : la lecture faite par la pastille remplit le cache partagé", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		expect(t.cache.current()).toEqual(active);
	});

	test("pricingUrl pointe vers /pricing/ dans la langue active", () => {
		const t = setup();
		expect(t.result.current.pricingUrl).toBe(
			"http://localhost:8080/pricing/?lang=fr",
		);
	});
});

describe("useAiScan : scans", () => {
	test("double appel à scan('text') pendant le premier : un seul client.scan", async () => {
		const t = setup();
		act(() => {
			t.result.current.scan("text");
			t.result.current.scan("text");
		});
		act(() => t.result.current.scan("text"));
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(t.result.current.text).toEqual({ status: "loading" });

		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.text).toEqual({
			status: "done",
			result: sampleAnalysis,
		});
		expect(t.result.current.image).toEqual({ status: "idle" });
	});

	test("la requête contient l'annonce complète, signals et rulesVersion du rapport", () => {
		const t = setup();
		act(() => t.result.current.scan("image"));
		expect(t.client.scan).toHaveBeenCalledWith({
			listing: listingOf("m1"),
			signals: report.signals,
			rulesVersion: 2,
			scanKind: "image",
			trigger: "button",
			partial: false,
		});
	});

	test("la clé change pendant un scan : la réponse est ignorée, text reste idle", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan("text"));
		t.rerender({ view: viewOf("m2") });
		expect(t.result.current.text).toEqual({ status: "idle" });

		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
		// La nouvelle annonce peut lancer son propre scan.
		act(() => t.result.current.scan("text"));
		expect(t.client.scan).toHaveBeenCalledTimes(2);
	});

	test("R8 : la clé change, l'accès actif est gardé sans relecture", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();

		t.rerender({ view: viewOf("m2") });
		expect(t.result.current.access).toEqual(active);
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(1);
	});

	test("R8 : la clé change, signedOut est affiché puis relu sans délai", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok({ status: "signedOut" }));
		await settle();

		t.rerender({ view: viewOf("m2") });
		expect(t.result.current.access).toEqual({ status: "signedOut" });
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(2);
	});

	test("I2 : même annonce, description modifiée après un scan : retour à idle (analyse locale)", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		expect(t.result.current.text).toEqual({ status: "idle" });
		// Un nouveau scan est possible sur l'annonce modifiée.
		act(() => t.result.current.scan("text"));
		expect(t.client.scan).toHaveBeenCalledTimes(2);
	});

	test("I2 : même annonce, autres champs (photos, vendeur) modifiés : états conservés", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		t.rerender({
			view: {
				report,
				listing: listingOf("m1", { images: [], seller: { name: "B" } }),
			},
		});
		expect(t.result.current.text.status).toBe("done");
	});

	test("I2 : annonce modifiée pendant le scan : le résultat de l'ancienne version n'est pas affiché", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan("text"));
		t.rerender({
			view: { report, listing: listingOf("m1", { title: "Vélo neuf" }) },
		});
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
	});

	test("fail('session_expired') : text en erreur et accès relu", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();

		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(fail("session_expired"));
		await settle();
		expect(t.result.current.text).toEqual({
			status: "error",
			code: "session_expired",
		});
		expect(t.client.access).toHaveBeenCalledTimes(2);
		// R8 : le cache partagé est invalidé, les icônes de cartes relisent aussi.
		expect(t.cache.current()).toBeNull();

		// R3 : l'accès relu dit signedOut, le panneau n'affichera que la connexion.
		t.accesses[1]?.resolve(ok({ status: "signedOut" }));
		await settle();
		expect(t.result.current.access).toEqual({ status: "signedOut" });
	});

	test("pendant la relecture de l'accès, l'accès précédent reste affiché", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.access).toHaveBeenCalledTimes(2);
		expect(t.result.current.access).toEqual(active);
	});

	test("R8 : relecture après un scan, malgré l'accès actif en cache ; remaining à jour", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.access).toHaveBeenCalledTimes(2);
		const after: ContentAccess = {
			...active,
			remaining: { text: 2, image: 3, total: null },
		};
		t.accesses[1]?.resolve(ok(after));
		await settle();
		expect(t.result.current.access).toEqual(after);
		expect(t.cache.current()).toEqual(after);
	});
});

describe("useAiScan : démontage", () => {
	test("scan terminé après le démontage : ni état, ni relecture de l'accès", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		act(() => t.result.current.scan("text"));
		const before = t.result.current;
		t.unmount();

		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.access).toHaveBeenCalledTimes(1);
		expect(t.result.current).toBe(before);
	});
});

describe("useAiScan : connexion", () => {
	test("login() sur fail('popup_unavailable') : loginUnavailable vrai", async () => {
		const t = setup();
		expect(t.result.current.loginUnavailable).toBe(false);
		act(() => t.result.current.login());
		expect(t.client.openLogin).toHaveBeenCalledTimes(1);
		t.logins[0]?.resolve(fail("popup_unavailable"));
		await settle();
		expect(t.result.current.loginUnavailable).toBe(true);
	});

	test("login() réussi : loginUnavailable reste faux", async () => {
		const t = setup();
		act(() => t.result.current.login());
		t.logins[0]?.resolve(ok(null));
		await settle();
		expect(t.result.current.loginUnavailable).toBe(false);
	});

	test("login() réussi après un échec : loginUnavailable repasse à faux", async () => {
		const t = setup();
		act(() => t.result.current.login());
		t.logins[0]?.resolve(fail("popup_unavailable"));
		await settle();
		expect(t.result.current.loginUnavailable).toBe(true);

		act(() => t.result.current.login());
		t.logins[1]?.resolve(ok(null));
		await settle();
		expect(t.result.current.loginUnavailable).toBe(false);
	});
});

/**
 * Magasin simulé : par `site|externalId`, une entrée ou une liste d'entrées
 * (une par type), rendues telles quelles ; lectures résolues tout de suite.
 */
function fakeStore(
	initial: Record<string, StoredAiResult | StoredAiResult[]> = {},
) {
	const entries: Record<string, StoredAiResults> = {};
	for (const [key, value] of Object.entries(initial))
		entries[key] = slotsOf(...[value].flat());
	return {
		get: vi.fn<AiResultStore["get"]>(
			async (site, id) => entries[`${site}|${id}`] ?? null,
		),
		put: vi.fn<AiResultStore["put"]>(async (site, id, entry) => {
			const key = `${site}|${id}`;
			entries[key] = { ...entries[key], [entry.scanKind]: entry };
		}),
		prune: vi.fn<AiResultStore["prune"]>(async () => {}),
	} satisfies AiResultStore;
}

/** Entrées rangées par type, comme `get` les rend. */
const slotsOf = (...list: StoredAiResult[]): StoredAiResults =>
	Object.fromEntries(list.map((e) => [e.scanKind, e]));

/** Résultat tel qu'adopté : sans le quota restant de l'époque (I1). */
const adopted = { ...sampleAnalysis, remaining: NO_REMAINING };

const storedFor = (
	listing: Listing,
	overrides: Partial<StoredAiResult> = {},
): StoredAiResult => ({
	result: sampleAnalysis,
	scanKind: "text",
	fingerprint: listingFingerprint(listing),
	storedAt: 1,
	...overrides,
});

describe("useAiScan : résultats gardés 24 h", () => {
	test("entrée stockée, même empreinte : done sans appel à client.scan", async () => {
		const store = fakeStore({ "2ememain.be|m1": storedFor(listingOf("m1")) });
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(store.get).toHaveBeenCalledWith("2ememain.be", "m1");
		expect(t.result.current.text).toEqual({
			status: "done",
			result: adopted,
		});
		expect(t.result.current.image).toEqual({ status: "idle" });
		expect(t.client.scan).not.toHaveBeenCalled();
	});

	test("entrée de type image : c'est l'état image qui passe à done", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), { scanKind: "image" }),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.image.status).toBe("done");
		expect(t.result.current.text).toEqual({ status: "idle" });
	});

	test("I1 : entrée stockée avec un quota (scans = 3) : aucun compteur repris", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), {
				result: {
					...sampleAnalysis,
					remaining: { scans: 3 },
				},
			}),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		const text = t.result.current.text;
		expect(text.status).toBe("done");
		expect(text.status === "done" && text.result.remaining).toEqual({
			scans: null,
		});
	});

	test("R4 : texte et photos stockés, tous deux valables : les deux à done", async () => {
		const store = fakeStore({
			"2ememain.be|m1": [
				storedFor(listingOf("m1")),
				storedFor(listingOf("m1"), {
					scanKind: "image",
					result: { ...sampleAnalysis, analysisId: 8 },
				}),
			],
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text).toEqual({ status: "done", result: adopted });
		expect(t.result.current.image).toEqual({
			status: "done",
			result: { ...adopted, analysisId: 8 },
		});
		expect(t.client.scan).not.toHaveBeenCalled();
	});

	test("R4 : chaque type est adopté seul (photos d'une autre empreinte, texte partiel)", async () => {
		const store = fakeStore({
			"2ememain.be|m1": [
				storedFor(listingOf("m1"), {
					result: { ...sampleAnalysis, partial: true },
				}),
				storedFor(listingOf("m1"), { scanKind: "image" }),
			],
			"2ememain.be|m2": [
				storedFor(listingOf("m2")),
				storedFor(listingOf("m2", { title: "Ancien" }), { scanKind: "image" }),
			],
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
		expect(t.result.current.image.status).toBe("done");
		t.rerender({ view: viewOf("m2") });
		await settle();
		expect(t.result.current.text.status).toBe("done");
		expect(t.result.current.image).toEqual({ status: "idle" });
	});

	test("R4 : un scan photos en cours n'empêche pas l'adoption du texte", async () => {
		const pending = deferred<StoredAiResults | null>();
		const store = fakeStore();
		store.get.mockImplementationOnce(() => pending.promise);
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan("image"));
		pending.resolve(
			slotsOf(
				storedFor(listingOf("m1")),
				storedFor(listingOf("m1"), { scanKind: "image" }),
			),
		);
		await settle();
		expect(t.result.current.text.status).toBe("done");
		expect(t.result.current.image).toEqual({ status: "loading" });
	});

	test("I2 : entrée restaurée, puis prix changé sous la même clé : idle", async () => {
		const store = fakeStore({
			"2ememain.be|m1": [
				storedFor(listingOf("m1")),
				storedFor(listingOf("m1"), { scanKind: "image" }),
			],
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text.status).toBe("done");
		t.rerender({
			view: {
				report,
				listing: listingOf("m1", {
					price: { amountCents: 9000, currency: "EUR" },
				}),
			},
		});
		expect(t.result.current.text).toEqual({ status: "idle" });
		expect(t.result.current.image).toEqual({ status: "idle" });
		expect(t.client.scan).not.toHaveBeenCalled();
	});

	test("description changée depuis l'analyse : idle", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1", { description: "Ancien." })),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
		expect(t.client.scan).not.toHaveBeenCalled();
	});

	test("prix baissé depuis l'analyse : idle", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(
				listingOf("m1", { price: { amountCents: 20000, currency: "EUR" } }),
			),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
	});

	test("entrée partielle (carte Facebook) : idle", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), {
				result: { ...sampleAnalysis, partial: true },
			}),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
	});

	test("après un scan réussi, l'entrée est écrite avec l'empreinte de l'annonce scannée", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan("image"));
		// L'annonce change pendant le scan : l'empreinte reste celle du clic.
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		const result = { ...sampleAnalysis, analysisId: 7 };
		t.scans[0]?.resolve(ok(result));
		await settle();
		expect(store.put).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledWith(
			"2ememain.be",
			"m1",
			expect.objectContaining({
				result,
				scanKind: "image",
				fingerprint: listingFingerprint(listingOf("m1")),
				storedAt: expect.any(Number),
			}),
		);
	});

	test("scan en échec : rien n'est écrit", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(fail("quota_exceeded"));
		await settle();
		expect(store.put).not.toHaveBeenCalled();
	});

	test("scan terminé avant la lecture du magasin : la lecture ne l'écrase pas", async () => {
		const pending = deferred<StoredAiResults | null>();
		const store = fakeStore();
		store.get.mockImplementationOnce(() => pending.promise);
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan("text"));
		const fresh = { ...sampleAnalysis, analysisId: 99 };
		t.scans[0]?.resolve(ok(fresh));
		await settle();
		pending.resolve(slotsOf(storedFor(listingOf("m1"))));
		await settle();
		expect(t.result.current.text).toEqual({ status: "done", result: fresh });
	});

	test("lecture du magasin pendant un scan du même type : le scan en cours l'emporte", async () => {
		const pending = deferred<StoredAiResults | null>();
		const store = fakeStore();
		store.get.mockImplementationOnce(() => pending.promise);
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan("text"));
		pending.resolve(slotsOf(storedFor(listingOf("m1"))));
		await settle();
		expect(t.result.current.text).toEqual({ status: "loading" });
	});

	test("nouvelle annonce : le magasin est relu pour elle ; la lecture de l'ancienne est ignorée", async () => {
		const slow = deferred<StoredAiResults | null>();
		const store = fakeStore({ "2ememain.be|m2": storedFor(listingOf("m2")) });
		store.get.mockImplementationOnce(() => slow.promise);
		const t = setup(viewOf("m1"), store);
		t.rerender({ view: viewOf("m2") });
		await settle();
		expect(store.get).toHaveBeenLastCalledWith("2ememain.be", "m2");
		expect(t.result.current.text.status).toBe("done");
		// La réponse tardive pour m1 n'est pas appliquée à m2 (empreinte de m1 identique).
		t.rerender({ view: viewOf("m3") });
		slow.resolve(slotsOf(storedFor(listingOf("m3"))));
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
	});

	test("même annonce, nouveaux rendus : le magasin n'est lu qu'une fois", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		t.rerender({ view: viewOf("m1") });
		t.rerender({
			view: { report, listing: listingOf("m1", { title: "Autre" }) },
		});
		await settle();
		expect(store.get).toHaveBeenCalledTimes(1);
	});

	test("magasin qui rejette : idle, et le scan fonctionne", async () => {
		const store = fakeStore();
		store.get.mockRejectedValue(new Error("indisponible"));
		store.put.mockRejectedValue(new Error("indisponible"));
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.text).toEqual({ status: "idle" });
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.text.status).toBe("done");
	});
});

/** Console simulée : les groupes écrits, titre et objet. */
function fakeSink() {
	const sink = {
		groupCollapsed: vi.fn<DebugSink["groupCollapsed"]>(),
		log: vi.fn<DebugSink["log"]>(),
		groupEnd: vi.fn<DebugSink["groupEnd"]>(),
	};
	const groups = () =>
		sink.groupCollapsed.mock.calls.map(([title], i) => ({
			title,
			data: sink.log.mock.calls[i]?.[0],
		}));
	return { sink, groups };
}

describe("useAiScan : relance sans cache (superuser)", () => {
	test("un scan ordinaire n'envoie pas noCache", () => {
		const t = setup();
		act(() => t.result.current.scan("text"));
		expect(t.client.scan.mock.calls[0]?.[0]).not.toHaveProperty("noCache");
	});

	test("rescan envoie la même requête avec noCache: true, pour le type demandé", async () => {
		const t = setup();
		act(() => t.result.current.scan("image"));
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		act(() => t.result.current.rescan("image"));
		const [first, second] = t.client.scan.mock.calls.map((c) => c[0]);
		expect(second).toEqual({ ...first, noCache: true });
		expect(second?.scanKind).toBe("image");
	});

	test("sticky : le résultat reste affiché pendant la relance, puis il est remplacé", async () => {
		const t = setup();
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();

		act(() => t.result.current.rescan("text"));
		// Pas de retour à `loading` (analyse locale) : seul le bouton l'indique.
		expect(t.result.current.text).toEqual({
			status: "done",
			result: debugAnalysis,
		});
		expect(t.result.current.rescanning.text).toBe(true);
		// Double clic pendant la relance : ignoré.
		act(() => t.result.current.rescan("text"));
		expect(t.client.scan).toHaveBeenCalledTimes(2);

		const fresh = { ...debugAnalysis, score: 90, level: "high" as const };
		t.scans[1]?.resolve(ok(fresh));
		await settle();
		expect(t.result.current.text).toEqual({ status: "done", result: fresh });
		expect(t.result.current.rescanning.text).toBeFalsy();
	});

	test("relance en erreur : le résultat reste, l'erreur est gardée à part, effacée à la relance suivante", async () => {
		const t = setup();
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		act(() => t.result.current.rescan("text"));
		t.scans[1]?.resolve(fail("rate_limited"));
		await settle();
		expect(t.result.current.text).toEqual({
			status: "done",
			result: debugAnalysis,
		});
		expect(t.result.current.rescanError.text).toBe("rate_limited");
		expect(t.result.current.rescanning.text).toBeFalsy();

		act(() => t.result.current.rescan("text"));
		expect(t.result.current.rescanError.text).toBeUndefined();
		t.scans[2]?.resolve(ok(debugAnalysis));
		await settle();
		expect(t.result.current.rescanError.text).toBeUndefined();
	});

	test("relance en erreur de session : l'accès en cache est invalidé, le résultat reste", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok({ ...active, debug: true }));
		await settle();
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		t.accesses[1]?.resolve(ok({ ...active, debug: true }));
		await settle();
		expect(t.cache.current()).not.toBeNull();

		act(() => t.result.current.rescan("text"));
		t.scans[1]?.resolve(fail("session_expired"));
		await settle();
		expect(t.result.current.text.status).toBe("done");
		expect(t.result.current.rescanError.text).toBe("session_expired");
		// R8 : cache vidé, l'accès est relu.
		expect(t.cache.current()).toBeNull();
		expect(t.client.access).toHaveBeenCalledTimes(3);
	});
});

describe("useAiScan : logs de debug (superuser)", () => {
	test("scan demandé avec la requête, puis scan reçu avec le résultat et son debug", async () => {
		const { sink, groups } = fakeSink();
		const t = setup(
			viewOf("m1"),
			undefined,
			createDebugLog(() => true, sink),
		);
		act(() => t.result.current.scan("text"));
		expect(groups()).toEqual([
			{
				title: "[Radarnaque debug] scan demandé",
				data: t.client.scan.mock.calls[0]?.[0],
			},
		]);
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		expect(groups()[1]).toEqual({
			title: "[Radarnaque debug] scan reçu",
			data: debugAnalysis,
		});
		expect(groups()).toHaveLength(2);
	});

	test("scan en erreur : scan reçu avec le code", async () => {
		const { sink, groups } = fakeSink();
		const t = setup(
			viewOf("m1"),
			undefined,
			createDebugLog(() => true, sink),
		);
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(groups()[1]).toEqual({
			title: "[Radarnaque debug] scan reçu",
			data: { error: "quota_exhausted" },
		});
	});

	test("utilisateur standard : aucun log", async () => {
		const { sink } = fakeSink();
		const t = setup(
			viewOf("m1"),
			undefined,
			createDebugLog(() => false, sink),
		);
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});
});
