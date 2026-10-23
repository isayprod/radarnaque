import type {
	AnalysisResult,
	IdentificationResult,
	ScanProgressEvent,
} from "@radarnaque/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
	ACTIVE_TTL_MS,
	type AccessCache,
	createAccessCache,
	RECHECK_MS,
} from "../lib/content/access-policy";
import type {
	AiClient,
	IdentifyHandle,
	ScanHandle,
} from "../lib/content/ai-client";
import {
	type AiResultStore,
	listingFingerprint,
	NO_REMAINING,
	type StoredAiResult,
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
import { debugAnalysis, sampleAnalysis, sampleIdentification } from "./helpers";

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
	features: ["ai"],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
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

const photos: ScanProgressEvent = { type: "stage", stage: "photos", count: 1 };
const search: ScanProgressEvent = {
	type: "search",
	id: 1,
	query: "vélo prix",
	aspect: "price",
};

/** Une analyse lancée par le faux client : son issue et ses événements viennent du test. */
interface FakeScan {
	request: ScanRequest;
	/** Événement de progression, relayé tel que le port le ferait. */
	emit(e: ScanProgressEvent): void;
	resolve(response: BgResponse<AnalysisResult>): void;
	cancel: ReturnType<typeof vi.fn<ScanHandle["cancel"]>>;
}

/** Une identification lancée par le faux client, menée depuis le test. */
interface FakeIdentify {
	request: ScanRequest;
	emit(e: ScanProgressEvent): void;
	resolve(response: BgResponse<IdentificationResult>): void;
	cancel: ReturnType<typeof vi.fn<IdentifyHandle["cancel"]>>;
}

/** Client simulé : chaque appel renvoie une promesse (ou une analyse) menée depuis le test. */
function fakeClient() {
	const scans: FakeScan[] = [];
	const identifies: FakeIdentify[] = [];
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
		scan: vi.fn(
			(request: ScanRequest, onEvent: (e: ScanProgressEvent) => void) => {
				const d = deferred<BgResponse<AnalysisResult>>();
				// Comme le vrai client : `cancel()` résout l'issue avec `cancelled`.
				const cancel = vi.fn(() => d.resolve(fail("cancelled")));
				scans.push({
					request,
					emit: (e) => act(() => onEvent(e)),
					resolve: d.resolve,
					cancel,
				});
				return { done: d.promise, cancel };
			},
		),
		identify: vi.fn(
			(request: ScanRequest, onEvent: (e: ScanProgressEvent) => void) => {
				const d = deferred<BgResponse<IdentificationResult>>();
				const cancel = vi.fn(() => d.resolve(fail("cancelled")));
				identifies.push({
					request,
					emit: (e) => act(() => onEvent(e)),
					resolve: d.resolve,
					cancel,
				});
				return { done: d.promise, cancel };
			},
		),
		openLogin: vi.fn(() => {
			const d = deferred<BgResponse<null>>();
			logins.push(d);
			return d.promise;
		}),
	} satisfies AiClient;
	return { client, scans, identifies, accesses, logins };
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

/** Analyse en cours, quelle que soit sa progression. */
const LOADING = expect.objectContaining({ status: "loading" });

/** Analyse terminée par un scan : elle garde sa progression. */
const doneWith = (result: AnalysisResult) => ({
	status: "done",
	result,
	progress: expect.objectContaining({ steps: expect.any(Array) }),
});

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
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		act(() => t.result.current.scan());
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
	test("double appel à scan() pendant le premier : un seul client.scan", async () => {
		const t = setup();
		expect(t.result.current.ai).toEqual({ status: "idle" });
		act(() => {
			t.result.current.scan();
			t.result.current.scan();
		});
		act(() => t.result.current.scan());
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(t.result.current.ai).toEqual({
			status: "loading",
			progress: expect.objectContaining({ steps: [], last: null }),
		});

		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.ai).toEqual(doneWith(sampleAnalysis));
	});

	test("la requête contient l'annonce complète, signals et rulesVersion du rapport, sans scanKind", () => {
		const t = setup();
		act(() => t.result.current.scan());
		expect(t.client.scan).toHaveBeenCalledWith(
			{
				listing: listingOf("m1"),
				signals: report.signals,
				rulesVersion: 2,
				trigger: "button",
				partial: false,
			},
			expect.any(Function),
		);
	});

	test("progress events update loading state", () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(photos);
		t.scans[0]?.emit(search);
		const state = t.result.current.ai;
		expect(state.status).toBe("loading");
		if (state.status !== "loading") return;
		expect(state.progress.steps.map((s) => s.event)).toEqual([photos, search]);
		expect(state.progress.last).toEqual(search);
	});

	test("done keeps progress", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(photos);
		t.scans[0]?.emit(search);
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		const state = t.result.current.ai;
		expect(state).toEqual(doneWith(sampleAnalysis));
		if (state.status !== "done") return;
		expect(state.progress?.steps.map((s) => s.event)).toEqual([photos, search]);
	});

	test("navigation to another listing cancels the scan and ignores its events", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(photos);

		t.rerender({ view: viewOf("m2") });
		// Point 4 de Review Focus : le port de l'ancienne annonce est fermé.
		expect(t.scans[0]?.cancel).toHaveBeenCalledTimes(1);
		expect(t.result.current.ai).toEqual({ status: "idle" });

		// La nouvelle annonce lance son propre scan.
		act(() => t.result.current.scan());
		expect(t.client.scan).toHaveBeenCalledTimes(2);
		expect(t.scans[1]?.request.listing.externalId).toBe("m2");

		// Événement et issue tardifs de l'ancienne annonce, par l'ancien handle :
		// la progression de m2 reste vide.
		t.scans[0]?.emit(search);
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		const state = t.result.current.ai;
		expect(state.status).toBe("loading");
		if (state.status !== "loading") return;
		expect(state.progress.steps).toEqual([]);
		// `cancelled` : ni relecture de l'accès, ni écriture.
		expect(t.client.access).toHaveBeenCalledTimes(1);
		expect(store.put).not.toHaveBeenCalled();
	});

	test("unmount cancels", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(photos);
		const before = t.result.current;
		t.unmount();
		expect(t.scans[0]?.cancel).toHaveBeenCalledTimes(1);

		t.scans[0]?.emit(search);
		await settle();
		expect(t.result.current).toBe(before);
		expect(t.client.access).not.toHaveBeenCalled();
	});

	test("un scan terminé n'est pas annulé au changement d'annonce", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		t.rerender({ view: viewOf("m2") });
		expect(t.scans[0]?.cancel).not.toHaveBeenCalled();
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
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		expect(t.result.current.ai).toEqual({ status: "idle" });
		// Un nouveau scan est possible sur l'annonce modifiée.
		act(() => t.result.current.scan());
		expect(t.client.scan).toHaveBeenCalledTimes(2);
	});

	test("I2 : même annonce, autres champs (photos, vendeur) modifiés : état conservé", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		t.rerender({
			view: {
				report,
				listing: listingOf("m1", { images: [], seller: { name: "B" } }),
			},
		});
		expect(t.result.current.ai.status).toBe("done");
	});

	test("I2 : annonce modifiée pendant le scan : le résultat de l'ancienne version n'est pas affiché", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan());
		t.rerender({
			view: { report, listing: listingOf("m1", { title: "Vélo neuf" }) },
		});
		// Même annonce : le scan n'est pas annulé.
		expect(t.scans[0]?.cancel).not.toHaveBeenCalled();
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.ai).toEqual({ status: "idle" });
	});

	test("fail('session_expired') : ai en erreur et accès relu", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();

		act(() => t.result.current.scan());
		t.scans[0]?.resolve(fail("session_expired"));
		await settle();
		expect(t.result.current.ai).toEqual({
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

	test.each(["stream_interrupted", "timeout"])(
		"fail('%s') : ai en erreur, un nouveau scan est possible",
		async (code) => {
			const t = setup();
			act(() => t.result.current.scan());
			t.scans[0]?.emit(photos);
			t.scans[0]?.resolve(fail(code));
			await settle();
			expect(t.result.current.ai).toEqual({ status: "error", code });
			act(() => t.result.current.scan());
			expect(t.client.scan).toHaveBeenCalledTimes(2);
			expect(t.result.current.ai).toEqual(LOADING);
		},
	);

	test("pendant la relecture de l'accès, l'accès précédent reste affiché", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();
		act(() => t.result.current.scan());
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
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.access).toHaveBeenCalledTimes(2);
		const after: ContentAccess = { ...active, remaining: { scans: 2 } };
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
		act(() => t.result.current.scan());
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
 * Magasin simulé : une entrée par `site|externalId`, rendue telle quelle ;
 * lectures résolues tout de suite.
 */
function fakeStore(initial: Record<string, StoredAiResult> = {}) {
	const entries: Record<string, StoredAiResult> = { ...initial };
	return {
		get: vi.fn<AiResultStore["get"]>(
			async (site, id) => entries[`${site}|${id}`] ?? null,
		),
		put: vi.fn<AiResultStore["put"]>(async (site, id, entry) => {
			entries[`${site}|${id}`] = entry;
		}),
		prune: vi.fn<AiResultStore["prune"]>(async () => {}),
		forgetIdentifiedByUser: vi.fn<AiResultStore["forgetIdentifiedByUser"]>(
			async (site, id, fingerprint) => {
				const entry = entries[`${site}|${id}`];
				if (entry?.fingerprint === fingerprint)
					entries[`${site}|${id}`] = { ...entry, identifiedByUser: false };
			},
		),
	} satisfies AiResultStore;
}

/** Résultat tel qu'adopté : sans le quota restant de l'époque (I1). */
const adopted = { ...sampleAnalysis, remaining: NO_REMAINING };

/** État d'un résultat repris du magasin : sans progression (rien n'a été suivi). */
const ADOPTED = { status: "done", result: adopted, progress: null };

const storedFor = (
	listing: Listing,
	overrides: Partial<StoredAiResult> = {},
): StoredAiResult => ({
	result: sampleAnalysis,
	identification: null,
	identifiedByUser: false,
	fingerprint: listingFingerprint(listing),
	storedAt: 1,
	...overrides,
});

describe("useAiScan : résultats gardés 24 h", () => {
	test("restoring : vrai jusqu'à la fin de la lecture du magasin, puis le résultat repris", async () => {
		const store = fakeStore({ "2ememain.be|m1": storedFor(listingOf("m1")) });
		const t = setup(viewOf("m1"), store);
		// Premier rendu : la lecture n'est pas finie, rien ne doit pouvoir lancer un scan.
		expect(t.result.current.restoring).toBe(true);
		expect(t.result.current.ai).toEqual({ status: "idle" });
		await settle();
		expect(t.result.current.restoring).toBe(false);
		expect(t.result.current.ai).toEqual(ADOPTED);
	});

	test("restoring : rien en magasin, faux une fois la lecture finie", async () => {
		const t = setup(viewOf("m1"), fakeStore());
		expect(t.result.current.restoring).toBe(true);
		await settle();
		expect(t.result.current.restoring).toBe(false);
		expect(t.result.current.ai).toEqual({ status: "idle" });
	});

	test("restoring : lecture du magasin en échec, faux quand même", async () => {
		const store = fakeStore();
		store.get.mockRejectedValueOnce(new Error("stockage indisponible"));
		const t = setup(viewOf("m1"), store);
		expect(t.result.current.restoring).toBe(true);
		await settle();
		expect(t.result.current.restoring).toBe(false);
		expect(t.result.current.ai).toEqual({ status: "idle" });
	});

	test("restoring : sans magasin, faux dès le premier rendu", () => {
		const t = setup(viewOf("m1"));
		expect(t.result.current.restoring).toBe(false);
	});

	test("restoring : nouvelle annonce, vrai jusqu'à la lecture de sa propre entrée", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.restoring).toBe(false);
		const pending = deferred<StoredAiResult | null>();
		store.get.mockReturnValueOnce(pending.promise);
		t.rerender({ view: viewOf("m2") });
		expect(t.result.current.restoring).toBe(true);
		await settle();
		expect(t.result.current.restoring).toBe(true);
		await act(async () => pending.resolve(null));
		expect(t.result.current.restoring).toBe(false);
	});

	test("stored result adopted without scan", async () => {
		const store = fakeStore({ "2ememain.be|m1": storedFor(listingOf("m1")) });
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(store.get).toHaveBeenCalledWith("2ememain.be", "m1");
		expect(t.result.current.ai).toEqual(ADOPTED);
		expect(t.client.scan).not.toHaveBeenCalled();
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
		const ai = t.result.current.ai;
		expect(ai.status).toBe("done");
		expect(ai.status === "done" && ai.result.remaining).toEqual({
			scans: null,
		});
	});

	test("I2 : entrée restaurée, puis prix changé sous la même clé : idle", async () => {
		const store = fakeStore({ "2ememain.be|m1": storedFor(listingOf("m1")) });
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.ai.status).toBe("done");
		t.rerender({
			view: {
				report,
				listing: listingOf("m1", {
					price: { amountCents: 9000, currency: "EUR" },
				}),
			},
		});
		expect(t.result.current.ai).toEqual({ status: "idle" });
		expect(t.client.scan).not.toHaveBeenCalled();
	});

	test("description changée depuis l'analyse : idle", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1", { description: "Ancien." })),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.ai).toEqual({ status: "idle" });
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
		expect(t.result.current.ai).toEqual({ status: "idle" });
	});

	test("entrée partielle (carte Facebook) : idle", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), {
				result: { ...sampleAnalysis, partial: true },
			}),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.ai).toEqual({ status: "idle" });
	});

	test("après un scan réussi, l'entrée est écrite avec l'empreinte de l'annonce scannée", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan());
		// L'annonce change pendant le scan : l'empreinte reste celle du clic.
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		const result = { ...sampleAnalysis, analysisId: 7 };
		t.scans[0]?.emit(photos);
		t.scans[0]?.resolve(ok(result));
		await settle();
		expect(store.put).toHaveBeenCalledTimes(1);
		// Une seule place par annonce, sans type ni progression.
		expect(store.put).toHaveBeenCalledWith("2ememain.be", "m1", {
			result,
			identification: null,
			identifiedByUser: false,
			fingerprint: listingFingerprint(listingOf("m1")),
			storedAt: expect.any(Number),
		});
	});

	test("scan en échec : rien n'est écrit", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(fail("quota_exceeded"));
		await settle();
		expect(store.put).not.toHaveBeenCalled();
	});

	test("scan terminé avant la lecture du magasin : la lecture ne l'écrase pas", async () => {
		const pending = deferred<StoredAiResult | null>();
		const store = fakeStore();
		store.get.mockImplementationOnce(() => pending.promise);
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan());
		const fresh = { ...sampleAnalysis, analysisId: 99 };
		t.scans[0]?.resolve(ok(fresh));
		await settle();
		pending.resolve(storedFor(listingOf("m1")));
		await settle();
		expect(t.result.current.ai).toEqual(doneWith(fresh));
	});

	test("lecture du magasin pendant un scan : le scan en cours l'emporte", async () => {
		const pending = deferred<StoredAiResult | null>();
		const store = fakeStore();
		store.get.mockImplementationOnce(() => pending.promise);
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.scan());
		pending.resolve(storedFor(listingOf("m1")));
		await settle();
		expect(t.result.current.ai).toEqual(LOADING);
	});

	test("nouvelle annonce : le magasin est relu pour elle ; la lecture de l'ancienne est ignorée", async () => {
		const slow = deferred<StoredAiResult | null>();
		const store = fakeStore({ "2ememain.be|m2": storedFor(listingOf("m2")) });
		store.get.mockImplementationOnce(() => slow.promise);
		const t = setup(viewOf("m1"), store);
		t.rerender({ view: viewOf("m2") });
		await settle();
		expect(store.get).toHaveBeenLastCalledWith("2ememain.be", "m2");
		expect(t.result.current.ai.status).toBe("done");
		// La réponse tardive pour m1 n'est pas appliquée à m3 (empreinte identique).
		t.rerender({ view: viewOf("m3") });
		slow.resolve(storedFor(listingOf("m3")));
		await settle();
		expect(t.result.current.ai).toEqual({ status: "idle" });
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
		expect(t.result.current.ai).toEqual({ status: "idle" });
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.ai.status).toBe("done");
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
		act(() => t.result.current.scan());
		expect(t.client.scan.mock.calls[0]?.[0]).not.toHaveProperty("noCache");
	});

	test("rescan envoie la même requête avec noCache: true", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		act(() => t.result.current.rescan());
		const [first, second] = t.client.scan.mock.calls.map((c) => c[0]);
		expect(second).toEqual({ ...first, noCache: true });
	});

	test("rescan keeps result displayed", async () => {
		const t = setup();
		expect(t.result.current.rescanning).toBe(false);
		expect(t.result.current.rescanError).toBeNull();
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		const displayed = t.result.current.ai;

		act(() => t.result.current.rescan());
		// Pas de retour à `loading` (analyse locale) : seul le bouton l'indique.
		expect(t.result.current.ai).toBe(displayed);
		expect(t.result.current.rescanning).toBe(true);
		// Les événements de la relance ne remplacent pas le résultat affiché.
		t.scans[1]?.emit(photos);
		expect(t.result.current.ai).toBe(displayed);
		// Double clic pendant la relance : ignoré.
		act(() => t.result.current.rescan());
		act(() => t.result.current.scan());
		expect(t.client.scan).toHaveBeenCalledTimes(2);

		const fresh = { ...debugAnalysis, score: 90, level: "high" as const };
		t.scans[1]?.resolve(ok(fresh));
		await settle();
		const state = t.result.current.ai;
		expect(state).toEqual(doneWith(fresh));
		// Le déroulé de la relance accompagne le nouveau résultat.
		expect(state.status === "done" && state.progress?.steps).toHaveLength(1);
		expect(t.result.current.rescanning).toBe(false);
	});

	test("relance en erreur : le résultat reste, l'erreur est gardée à part, effacée à la relance suivante", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		act(() => t.result.current.rescan());
		t.scans[1]?.resolve(fail("rate_limited"));
		await settle();
		expect(t.result.current.ai).toEqual(doneWith(debugAnalysis));
		expect(t.result.current.rescanError).toBe("rate_limited");
		expect(t.result.current.rescanning).toBe(false);

		act(() => t.result.current.rescan());
		expect(t.result.current.rescanError).toBeNull();
		t.scans[2]?.resolve(ok(debugAnalysis));
		await settle();
		expect(t.result.current.rescanError).toBeNull();
	});

	test("relance annulée par un changement d'annonce : ni erreur, ni relance en cours", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		act(() => t.result.current.rescan());
		t.rerender({ view: viewOf("m2") });
		expect(t.scans[1]?.cancel).toHaveBeenCalledTimes(1);
		await settle();
		expect(t.result.current.ai).toEqual({ status: "idle" });
		expect(t.result.current.rescanning).toBe(false);
		expect(t.result.current.rescanError).toBeNull();
	});

	test("relance en erreur de session : l'accès en cache est invalidé, le résultat reste", async () => {
		const t = setup();
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok({ ...active, debug: true }));
		await settle();
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(debugAnalysis));
		await settle();
		t.accesses[1]?.resolve(ok({ ...active, debug: true }));
		await settle();
		expect(t.cache.current()).not.toBeNull();

		act(() => t.result.current.rescan());
		t.scans[1]?.resolve(fail("session_expired"));
		await settle();
		expect(t.result.current.ai.status).toBe("done");
		expect(t.result.current.rescanError).toBe("session_expired");
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
		act(() => t.result.current.scan());
		expect(groups()).toEqual([
			{
				title: "[Radarnaque debug] scan demandé",
				data: t.client.scan.mock.calls[0]?.[0],
			},
		]);
		t.scans[0]?.emit(photos);
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
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(groups()[1]).toEqual({
			title: "[Radarnaque debug] scan reçu",
			data: { error: "quota_exhausted" },
		});
	});

	test("scan annulé (navigation) : aucun « scan reçu »", async () => {
		const { sink, groups } = fakeSink();
		const t = setup(
			viewOf("m1"),
			undefined,
			createDebugLog(() => true, sink),
		);
		act(() => t.result.current.scan());
		t.rerender({ view: viewOf("m2") });
		await settle();
		expect(groups().map((g) => g.title)).toEqual([
			"[Radarnaque debug] scan demandé",
		]);
	});

	test("utilisateur standard : aucun log", async () => {
		const { sink } = fakeSink();
		const t = setup(
			viewOf("m1"),
			undefined,
			createDebugLog(() => false, sink),
		);
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});
});

const readingPhotos: ScanProgressEvent = {
	type: "stage",
	stage: "reading_photos",
};
const identifying: ScanProgressEvent = { type: "stage", stage: "identifying" };
const searchDone: ScanProgressEvent = {
	type: "search_done",
	id: 1,
	ok: true,
	count: 3,
	domains: ["www.steamdeck.com"],
};
const thinking: ScanProgressEvent = {
	type: "thinking",
	part: 0,
	text: "Je compare les photos.",
};
const criteriaCached: ScanProgressEvent = { type: "criteria_cached", count: 3 };
const pageRead: ScanProgressEvent = {
	type: "page_read",
	domain: "www.steamdeck.com",
	ok: true,
};
/** L'événement `identification` du flux : les champs du résultat, à plat. */
const identificationEvent = (
	result: IdentificationResult = sampleIdentification,
): ScanProgressEvent => {
	const { debug: _, ...fields } = result;
	return { ...fields, type: "identification" };
};
/** Identification telle que reprise du magasin : sans quota restant ni déroulé. */
const RESTORED_IDENTIFICATION = {
	status: "done",
	result: { ...sampleIdentification, remaining: NO_REMAINING },
	progress: null,
};
/** Identification terminée en direct : elle garde son déroulé. */
const identifiedWith = (result: IdentificationResult) => ({
	status: "done",
	result,
	progress: expect.objectContaining({ steps: expect.any(Array) }),
});
const stepsOf = (state: { status: string; progress?: unknown }) =>
	(
		state as {
			progress?: { steps: Array<{ event: ScanProgressEvent }> } | null;
		}
	).progress?.steps.map((s) => s.event);

describe("useAiScan : identification", () => {
	test("identify goes loading then done and stores identifiedByUser", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.identification).toEqual({ status: "idle" });

		act(() => t.result.current.identify());
		expect(t.client.identify).toHaveBeenCalledTimes(1);
		expect(t.client.scan).not.toHaveBeenCalled();
		expect(t.identifies[0]?.request).toEqual({
			listing: listingOf("m1"),
			signals: report.signals,
			rulesVersion: 2,
			trigger: "button",
			partial: false,
		});
		expect(t.result.current.identification).toEqual(LOADING);
		t.identifies[0]?.emit(readingPhotos);
		t.identifies[0]?.emit(search);
		expect(stepsOf(t.result.current.identification)).toEqual([
			readingPhotos,
			search,
		]);
		// L'analyse n'est pas touchée.
		expect(t.result.current.ai).toEqual({ status: "idle" });

		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.result.current.identification).toEqual(
			identifiedWith(sampleIdentification),
		);
		expect(stepsOf(t.result.current.identification)).toEqual([
			readingPhotos,
			search,
		]);
		expect(store.put).toHaveBeenCalledWith("2ememain.be", "m1", {
			result: null,
			identification: sampleIdentification,
			identifiedByUser: true,
			fingerprint: listingFingerprint(listingOf("m1")),
			storedAt: expect.any(Number),
		});
		// Quota consommé : l'accès est relu.
		expect(t.client.access).toHaveBeenCalledTimes(1);
	});

	test("identification en erreur : son code, rien n'est écrit, accès relu", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.identify());
		t.identifies[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(t.result.current.identification).toEqual({
			status: "error",
			code: "quota_exhausted",
		});
		expect(store.put).not.toHaveBeenCalled();
		expect(t.client.access).toHaveBeenCalledTimes(1);
	});

	test("no second identify while one runs (double click)", async () => {
		const t = setup();
		act(() => {
			t.result.current.identify();
			t.result.current.identify();
		});
		act(() => t.result.current.identify());
		expect(t.client.identify).toHaveBeenCalledTimes(1);
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();

		// Pas d'identification pendant une analyse non plus.
		act(() => t.result.current.scan());
		act(() => t.result.current.identify());
		expect(t.client.identify).toHaveBeenCalledTimes(1);
		// Ni de relance sans cache pendant une identification.
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		act(() => t.result.current.identify());
		act(() => t.result.current.rescan());
		expect(t.client.identify).toHaveBeenCalledTimes(2);
		expect(t.client.scan).toHaveBeenCalledTimes(1);
	});

	test("scan during identify is queued then starts when identify finishes", async () => {
		const t = setup();
		expect(t.result.current.queued).toBe(false);
		act(() => t.result.current.identify());
		act(() => t.result.current.scan());
		act(() => t.result.current.scan());
		expect(t.client.scan).not.toHaveBeenCalled();
		expect(t.result.current.queued).toBe(true);
		expect(t.result.current.ai).toEqual({ status: "idle" });

		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(t.scans[0]?.request.listing).toEqual(listingOf("m1"));
		expect(t.result.current.queued).toBe(false);
		expect(t.result.current.ai).toEqual(LOADING);
		expect(t.result.current.identification.status).toBe("done");
	});

	test("queued scan still starts after an identify error", async () => {
		const t = setup();
		act(() => t.result.current.identify());
		act(() => t.result.current.scan());
		t.identifies[0]?.resolve(fail("identification_failed"));
		await settle();
		// L'analyse partie de la file refait l'identification : de nouveau en cours.
		expect(t.result.current.identification).toEqual(LOADING);
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(t.result.current.queued).toBe(false);
		expect(t.result.current.ai).toEqual(LOADING);
	});

	test("queued scan is dropped when the listing changes", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.identify());
		act(() => t.result.current.scan());
		expect(t.result.current.queued).toBe(true);

		t.rerender({ view: viewOf("m2") });
		expect(t.identifies[0]?.cancel).toHaveBeenCalledTimes(1);
		expect(t.result.current.queued).toBe(false);
		expect(t.result.current.identification).toEqual({ status: "idle" });
		await settle();
		expect(t.client.scan).not.toHaveBeenCalled();
		// Annulée : ni relecture de l'accès.
		expect(t.client.access).not.toHaveBeenCalled();
		// Une identification tardive de m1 ne touche pas m2.
		t.identifies[0]?.emit(readingPhotos);
		expect(t.result.current.identification).toEqual({ status: "idle" });
	});

	test("file oubliée quand l'annonce est modifiée pendant l'identification", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.identify());
		act(() => t.result.current.scan());
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		expect(t.result.current.queued).toBe(false);
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.client.scan).not.toHaveBeenCalled();
		// L'identification de l'ancienne version n'est pas affichée.
		expect(t.result.current.identification).toEqual({ status: "idle" });
	});

	test("identification faite, puis annonce modifiée : retour à idle", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.identify());
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.result.current.analysisIncluded).toBe(true);
		t.rerender({
			view: { report, listing: listingOf("m1", { title: "Autre" }) },
		});
		expect(t.result.current.identification).toEqual({ status: "idle" });
		expect(t.result.current.analysisIncluded).toBe(false);
	});

	test("scan without identification fills both states from the stream", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		act(() => t.result.current.scan());
		expect(t.client.identify).not.toHaveBeenCalled();
		t.scans[0]?.emit(readingPhotos);
		expect(t.result.current.identification).toEqual(LOADING);
		// Recherche, résultat et réflexion de la phase d'identification : son déroulé.
		t.scans[0]?.emit(search);
		t.scans[0]?.emit(searchDone);
		t.scans[0]?.emit(thinking);
		t.scans[0]?.emit(criteriaCached);
		t.scans[0]?.emit(pageRead);
		t.scans[0]?.emit(identifying);
		t.scans[0]?.emit(identificationEvent());
		expect(t.result.current.identification).toEqual(
			identifiedWith(sampleIdentification),
		);
		expect(stepsOf(t.result.current.identification)).toEqual([
			readingPhotos,
			search,
			searchDone,
			thinking,
			criteriaCached,
			pageRead,
			identifying,
			identificationEvent(),
		]);
		expect(stepsOf(t.result.current.ai)).toEqual([]);
		t.scans[0]?.emit(photos);
		t.scans[0]?.emit(search);
		t.scans[0]?.emit(thinking);
		// Chaque pilule a son propre déroulé.
		expect(stepsOf(t.result.current.ai)).toEqual([photos, search, thinking]);

		const result = { ...sampleAnalysis, identification: sampleIdentification };
		t.scans[0]?.resolve(ok(result));
		await settle();
		expect(t.result.current.ai).toEqual(doneWith(result));
		expect(t.result.current.identification).toEqual(
			identifiedWith(sampleIdentification),
		);
		expect(t.result.current.analysisIncluded).toBe(false);
		expect(store.put).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledWith("2ememain.be", "m1", {
			result,
			identification: sampleIdentification,
			identifiedByUser: false,
			fingerprint: listingFingerprint(listingOf("m1")),
			storedAt: expect.any(Number),
		});
	});

	test("l'identification du résultat de l'analyse devient l'identification affichée", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		const result = { ...sampleAnalysis, identification: sampleIdentification };
		t.scans[0]?.resolve(ok(result));
		await settle();
		expect(t.result.current.identification).toEqual({
			status: "done",
			result: sampleIdentification,
			progress: null,
		});
	});

	test("identification_error during scan sets identification error and the scan completes", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(identifying);
		t.scans[0]?.emit({
			type: "identification_error",
			code: "identification_failed",
		});
		expect(t.result.current.identification).toEqual({
			status: "error",
			code: "identification_failed",
		});
		t.scans[0]?.emit(photos);
		expect(t.result.current.ai).toEqual(LOADING);
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.ai).toEqual(doneWith(sampleAnalysis));
		expect(t.result.current.identification).toEqual({
			status: "error",
			code: "identification_failed",
		});
	});

	test("analyse en erreur pendant l'identification du flux : l'identification prend son code", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(readingPhotos);
		t.scans[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(t.result.current.identification).toEqual({
			status: "error",
			code: "quota_exhausted",
		});
	});

	test("analyse finie sans identification : l'identification en cours revient à idle", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		t.scans[0]?.emit(readingPhotos);
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		expect(t.result.current.identification).toEqual({ status: "idle" });
	});

	test("identification déjà faite : les événements du flux ne la remettent pas en cours", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), {
				result: null,
				identification: sampleIdentification,
				identifiedByUser: true,
			}),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		const restored = t.result.current.identification;
		expect(restored).toEqual(RESTORED_IDENTIFICATION);

		act(() => t.result.current.scan());
		t.scans[0]?.emit(readingPhotos);
		t.scans[0]?.emit(criteriaCached);
		expect(t.result.current.identification).toBe(restored);
		t.scans[0]?.emit({ type: "identification_error", code: "x_failed" });
		expect(t.result.current.identification).toBe(restored);
		// Servie du cache, l'identification fraîche remplace celle reprise.
		const fresh = { ...sampleIdentification, fromCache: true };
		t.scans[0]?.emit(identificationEvent(fresh));
		expect(t.result.current.identification).toEqual(identifiedWith(fresh));
		t.scans[0]?.resolve(ok({ ...sampleAnalysis, identification: fresh }));
		await settle();
		expect(t.result.current.identification).toEqual(identifiedWith(fresh));
		// Toujours l'identification de l'utilisateur, mais l'analyse est faite.
		expect(t.result.current.analysisIncluded).toBe(false);
	});

	test("analysisIncluded only after the user's own identify", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.analysisIncluded).toBe(false);
		act(() => t.result.current.identify());
		expect(t.result.current.analysisIncluded).toBe(false);
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.result.current.analysisIncluded).toBe(true);

		act(() => t.result.current.scan());
		t.scans[0]?.resolve(
			ok({ ...sampleAnalysis, identification: sampleIdentification }),
		);
		await settle();
		expect(t.result.current.analysisIncluded).toBe(false);
		// L'analyse n'écrit pas le drapeau : le magasin le garde pour la même empreinte.
		expect(store.put).toHaveBeenLastCalledWith(
			"2ememain.be",
			"m1",
			expect.objectContaining({ identifiedByUser: false }),
		);

		// Une identification venue d'une analyse ne compte pas.
		const other = setup(viewOf("m2"));
		act(() => other.result.current.scan());
		other.scans[0]?.emit(identificationEvent());
		expect(other.result.current.identification.status).toBe("done");
		expect(other.result.current.analysisIncluded).toBe(false);
	});

	test("restored identification from an analysis does not mark analysisIncluded", async () => {
		// Analyse partielle d'une carte, avec son identification : pastille « Analyser ».
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), {
				result: { ...sampleAnalysis, partial: true },
				identification: sampleIdentification,
				identifiedByUser: false,
			}),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.ai).toEqual({ status: "idle" });
		expect(t.result.current.identification).toEqual(RESTORED_IDENTIFICATION);
		expect(t.result.current.analysisIncluded).toBe(false);
	});

	test("restores identification and analysis separately from the store", async () => {
		const store = fakeStore({
			"2ememain.be|m1": storedFor(listingOf("m1"), {
				result: null,
				identification: sampleIdentification,
				identifiedByUser: true,
			}),
			"2ememain.be|m2": storedFor(listingOf("m2"), {
				identification: sampleIdentification,
				identifiedByUser: true,
			}),
			"2ememain.be|m3": storedFor(listingOf("m3", { description: "Ancien." }), {
				identification: sampleIdentification,
			}),
		});
		const t = setup(viewOf("m1"), store);
		await settle();
		expect(t.result.current.identification).toEqual(RESTORED_IDENTIFICATION);
		expect(t.result.current.ai).toEqual({ status: "idle" });
		expect(t.result.current.analysisIncluded).toBe(true);

		t.rerender({ view: viewOf("m2") });
		await settle();
		expect(t.result.current.identification).toEqual(RESTORED_IDENTIFICATION);
		expect(t.result.current.ai).toEqual(ADOPTED);
		expect(t.result.current.analysisIncluded).toBe(false);

		// Annonce modifiée depuis : ni l'une ni l'autre.
		t.rerender({ view: viewOf("m3") });
		await settle();
		expect(t.result.current.identification).toEqual({ status: "idle" });
		expect(t.result.current.ai).toEqual({ status: "idle" });
		expect(t.client.scan).not.toHaveBeenCalled();
		expect(t.client.identify).not.toHaveBeenCalled();
	});

	test("lecture du magasin pendant une identification : l'identification en cours l'emporte", async () => {
		const pending = deferred<StoredAiResult | null>();
		const store = fakeStore();
		store.get.mockImplementationOnce(() => pending.promise);
		const t = setup(viewOf("m1"), store);
		act(() => t.result.current.identify());
		pending.resolve(
			storedFor(listingOf("m1"), {
				result: null,
				identification: sampleIdentification,
				identifiedByUser: true,
			}),
		);
		await settle();
		expect(t.result.current.identification).toEqual(LOADING);
	});

	test("« Analyser » met l'identification en cours dès le clic, avec son propre déroulé", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		// Avant tout événement : la pilule « Identifier » est en cours.
		expect(t.result.current.identification).toEqual(LOADING);
		expect(stepsOf(t.result.current.identification)).toEqual([]);
		t.scans[0]?.emit(photos);
		expect(stepsOf(t.result.current.identification)).toEqual([]);
		// Identification servie du cache : en cours, puis faite.
		t.scans[0]?.emit(identificationEvent());
		expect(t.result.current.identification).toEqual(
			identifiedWith(sampleIdentification),
		);
	});

	test("analyse en échec avant tout événement de l'identification : l'identification revient au repos", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		expect(t.result.current.identification).toEqual(LOADING);
		t.scans[0]?.emit(photos);
		t.scans[0]?.resolve(fail("analysis_failed"));
		await settle();
		expect(t.result.current.identification).toEqual({ status: "idle" });
	});

	test("analyse incluse refusée (quota épuisé) : l'identification n'est plus celle de l'utilisateur", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		act(() => t.result.current.identify());
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.result.current.analysisIncluded).toBe(true);

		act(() => t.result.current.scan());
		t.scans[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(t.result.current.ai).toEqual({
			status: "error",
			code: "quota_exhausted",
		});
		// Plus d'« Inclus » : un nouveau clic ne boucle pas sur le refus.
		expect(t.result.current.analysisIncluded).toBe(false);
		expect(t.result.current.identification.status).toBe("done");
		expect(store.forgetIdentifiedByUser).toHaveBeenCalledWith(
			"2ememain.be",
			"m1",
			listingFingerprint(listingOf("m1")),
		);
		expect((await store.get("2ememain.be", "m1"))?.identifiedByUser).toBe(
			false,
		);
	});

	test("analyse incluse partie de la file, refusée (quota épuisé) : plus d'« Inclus »", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		act(() => t.result.current.identify());
		act(() => t.result.current.scan());
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		t.scans[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(t.result.current.analysisIncluded).toBe(false);
		expect(store.forgetIdentifiedByUser).toHaveBeenCalledWith(
			"2ememain.be",
			"m1",
			listingFingerprint(listingOf("m1")),
		);
	});

	test("autre erreur, ou quota épuisé sans analyse incluse : le drapeau reste", async () => {
		const store = fakeStore();
		const t = setup(viewOf("m1"), store);
		await settle();
		act(() => t.result.current.identify());
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		act(() => t.result.current.scan());
		t.scans[0]?.resolve(fail("analysis_failed"));
		await settle();
		expect(t.result.current.analysisIncluded).toBe(true);
		expect(store.forgetIdentifiedByUser).not.toHaveBeenCalled();

		const other = setup(viewOf("m2"), store);
		await settle();
		act(() => other.result.current.scan());
		other.scans[0]?.resolve(fail("quota_exhausted"));
		await settle();
		expect(store.forgetIdentifiedByUser).not.toHaveBeenCalled();
	});

	test("« Analyser » après une modification pendant l'identification : mis en file pour la version affichée", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.identify());
		const edited = listingOf("m1", { description: "Autre." });
		t.rerender({ view: { report, listing: edited } });
		act(() => t.result.current.scan());
		expect(t.client.scan).not.toHaveBeenCalled();
		expect(t.result.current.queued).toBe(true);
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.client.scan).toHaveBeenCalledTimes(1);
		expect(t.scans[0]?.request.listing).toEqual(edited);
		expect(t.result.current.queued).toBe(false);
		expect(t.result.current.ai).toEqual(LOADING);
	});

	test("file oubliée si l'annonce change encore avant la fin de l'identification", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.identify());
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		act(() => t.result.current.scan());
		expect(t.result.current.queued).toBe(true);
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Encore." }) },
		});
		expect(t.result.current.queued).toBe(false);
		t.identifies[0]?.resolve(ok(sampleIdentification));
		await settle();
		expect(t.client.scan).not.toHaveBeenCalled();
	});

	test("relance sans cache : les événements d'identification ne touchent ni l'identification ni le déroulé", async () => {
		const t = setup();
		act(() => t.result.current.scan());
		const first = { ...sampleAnalysis, identification: sampleIdentification };
		t.scans[0]?.resolve(ok(first));
		await settle();
		const shown = t.result.current.identification;
		expect(shown.status).toBe("done");

		act(() => t.result.current.rescan());
		t.scans[1]?.emit(readingPhotos);
		t.scans[1]?.emit(search);
		t.scans[1]?.emit(thinking);
		const fresh = { ...sampleIdentification, identificationId: 8 };
		t.scans[1]?.emit(identificationEvent(fresh));
		expect(t.result.current.identification).toBe(shown);
		t.scans[1]?.emit(photos);
		t.scans[1]?.emit(searchDone);
		const second = { ...sampleAnalysis, identification: fresh };
		t.scans[1]?.resolve(ok(second));
		await settle();
		// Le résultat de la relance remplace l'identification affichée…
		expect(t.result.current.identification).toEqual(
			expect.objectContaining({ status: "done", result: fresh }),
		);
		// … et son déroulé ne garde que les étapes de l'analyse.
		expect(t.result.current.ai).toEqual(doneWith(second));
		expect(stepsOf(t.result.current.ai)).toEqual([photos, searchDone]);
	});

	test("identification démontée : annulée, ni état ni relecture", async () => {
		const t = setup();
		act(() => t.result.current.identify());
		t.unmount();
		expect(t.identifies[0]?.cancel).toHaveBeenCalledTimes(1);
		await settle();
		expect(t.client.access).not.toHaveBeenCalled();
	});
});
