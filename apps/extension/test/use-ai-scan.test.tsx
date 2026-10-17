import type { AnalysisResult } from "@radarnaque/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { AiClient } from "../lib/content/ai-client";
import { type BadgeView, useAiScan } from "../lib/content/use-ai-scan";
import type { Listing } from "../lib/listing/types";
import type { BgResponse, ContentAccess } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";
import { sampleAnalysis } from "./helpers";

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
		scan: vi.fn(() => {
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

function setup(initial: BadgeView = viewOf("m1")) {
	const fake = fakeClient();
	const hook = renderHook(
		({ view }: { view: BadgeView }) => useAiScan(fake.client, view, "fr"),
		{ initialProps: { view: initial } },
	);
	return { ...fake, ...hook };
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

	test("la clé change : l'accès revient à « non chargé » et loadAccess le relit", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.loadAccess());
		t.accesses[0]?.resolve(ok(active));
		await settle();

		t.rerender({ view: viewOf("m2") });
		expect(t.result.current.access).toBe("loading");
		act(() => t.result.current.loadAccess());
		expect(t.client.access).toHaveBeenCalledTimes(2);
	});

	test("même annonce, description modifiée : les états sont conservés", async () => {
		const t = setup(viewOf("m1"));
		act(() => t.result.current.scan("text"));
		t.scans[0]?.resolve(ok(sampleAnalysis));
		await settle();
		t.rerender({
			view: { report, listing: listingOf("m1", { description: "Autre." }) },
		});
		expect(t.result.current.text.status).toBe("done");
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
});
