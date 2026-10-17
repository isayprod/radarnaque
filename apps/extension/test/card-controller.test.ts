import type { AnalysisResult, Locale } from "@radarnaque/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CardRef } from "../lib/adapters/types";
import type { AiClient } from "../lib/content/ai-client";
import {
	CARD_HOST_TAG,
	type CardMount,
	type CardView,
	createCardController,
} from "../lib/content/card-controller";
import type { scanCard } from "../lib/content/card-scan";
import type { BgResponse, ContentAccess } from "../lib/messages";
import { loadFixture, sampleAnalysis } from "./helpers";

const FB_SEARCH = "https://www.facebook.com/marketplace/brussels/";
const FB_ITEM = "https://www.facebook.com/marketplace/item/9000000000000001/";
const TWH_SEARCH = "https://www.2ememain.be/q/iphone/";
const FB_IDS = [1, 2, 3, 4, 5, 6].map((n) => `900000000000000${n}`);
const TWH_IDS = [101, 102, 103, 104, 105, 106].map((n) => `m1000000${n}`);

const withCards: ContentAccess = {
	status: "active",
	features: ["card_icons"],
	unlimited: false,
	remaining: { text: 3, image: null, total: null },
};
const standard: ContentAccess = { ...withCards, features: [] };
const signedOut: ContentAccess = { status: "signedOut" };

interface FakeMount {
	anchor: Element;
	card: CardRef;
	views: CardView[];
	host: Element;
	unmounted: boolean;
}

/** `mountCard` simulé : insère un hôte vide après l'ancre, comme WXT. */
function fakeMounts() {
	const mounts: FakeMount[] = [];
	const mountCard = vi.fn(
		(anchor: Element, card: CardRef, view: CardView): CardMount => {
			const host = anchor.ownerDocument.createElement(CARD_HOST_TAG);
			anchor.after(host);
			const m: FakeMount = {
				anchor,
				card,
				views: [view],
				host,
				unmounted: false,
			};
			mounts.push(m);
			return {
				update: (next) => m.views.push(next),
				unmount: () => {
					m.unmounted = true;
					host.remove();
				},
				isMounted: () => host.isConnected,
			};
		},
	);
	const live = () => mounts.filter((m) => !m.unmounted);
	const liveOf = (id: string) => {
		const found = live().filter((m) => m.card.externalId === id);
		if (found.length !== 1)
			throw new Error(`${found.length} icônes pour ${id}`);
		return found[0] as FakeMount;
	};
	const lastView = (id: string) => liveOf(id).views.at(-1) as CardView;
	return { mounts, mountCard, live, liveOf, lastView };
}

/** Promesse résolue de l'extérieur. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.useRealTimers();
});

function setup(
	doc: Document,
	initialUrl: string,
	accesses: ContentAccess[] = [withCards],
) {
	let url = new URL(initialUrl);
	let locale: Locale = "fr";
	const queue = [...accesses];
	const ai = {
		access: vi.fn<AiClient["access"]>(async () => ({
			ok: true,
			data: (queue.length > 1 ? queue.shift() : queue[0]) as ContentAccess,
		})),
		scan: vi.fn<AiClient["scan"]>(),
		openLogin: vi.fn<AiClient["openLogin"]>(),
	};
	const scan = vi.fn<typeof scanCard>(async () => ({
		ok: true,
		data: sampleAnalysis,
	}));
	const fetchPage = vi.fn(async () => "");
	const fake = fakeMounts();
	const getLocale = vi.fn(async () => locale);
	const getUrl = vi.fn(() => url);
	const controller = createCardController({
		doc,
		getUrl,
		ai,
		mountCard: fake.mountCard,
		getLocale,
		win: window,
		scan,
		fetchPage,
		log: vi.fn(),
	});
	disposers.push(controller.dispose);
	return {
		...fake,
		ai,
		scan,
		fetchPage,
		controller,
		getLocale,
		getUrl,
		navigate(next: string) {
			url = new URL(next);
		},
		setLocale(next: Locale) {
			locale = next;
		},
		setAccess(...next: ContentAccess[]) {
			queue.splice(0, queue.length, ...next);
		},
	};
}

const marked = (doc: Document) =>
	[...doc.querySelectorAll("[data-radarnaque-card]")].map((el) =>
		el.getAttribute("data-radarnaque-card"),
	);

describe("createCardController — icônes", () => {
	test("Facebook, accès card_icons : 6 icônes, un second refresh n'en ajoute aucune", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		await t.controller.refresh();

		expect(t.mountCard).toHaveBeenCalledTimes(6);
		expect(t.live().map((m) => m.card.externalId)).toEqual(FB_IDS);
		expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(6);
		expect(marked(doc)).toEqual(FB_IDS);
		expect(t.ai.access).toHaveBeenCalledTimes(1);
		expect(t.getLocale).toHaveBeenCalledWith("facebook.com");
		expect(t.lastView(FB_IDS[0] as string)).toMatchObject({
			state: { status: "idle" },
			locale: "fr",
		});
	});

	test("2ememain : une icône par carte, après le titre", async () => {
		const doc = loadFixture("twh/search.html");
		const t = setup(doc, TWH_SEARCH);
		await t.controller.refresh();
		expect(t.live().map((m) => m.card.externalId)).toEqual(TWH_IDS);
		for (const m of t.live()) {
			expect(m.card.element.contains(m.host)).toBe(true);
			expect(m.host.previousElementSibling).toBe(m.anchor);
		}
	});

	test("R2 : jamais dans un sous-arbre aria-hidden", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(6);
		for (const m of t.live()) {
			expect(m.host.closest('[aria-hidden="true"]')).toBeNull();
			expect(m.card.element.contains(m.host)).toBe(true);
		}
		// Cartes 1 à 3 : titre sous <span aria-hidden="true"> ; l'icône suit ce span.
		for (const id of FB_IDS.slice(0, 3)) {
			const anchor = t.liveOf(id).anchor;
			expect(anchor.getAttribute("aria-hidden")).toBe("true");
			expect(anchor.textContent?.trim()).toBe(
				t.liveOf(id).card.element.querySelectorAll('span[dir="auto"]')[1]
					?.textContent,
			);
		}
	});

	test.each([
		["standard (features: [])", standard],
		["signedOut", signedOut],
		["noSubscription", { status: "noSubscription" } as ContentAccess],
	])("accès %s : aucune icône", async (_, access) => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [access]);
		await t.controller.refresh();
		expect(t.mountCard).not.toHaveBeenCalled();
		expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(0);
	});

	test("accès en erreur : aucune icône", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		t.ai.access.mockResolvedValue({
			ok: false,
			error: { code: "background_unavailable" },
		});
		await t.controller.refresh();
		expect(t.mountCard).not.toHaveBeenCalled();
	});

	test("hors page de recherche, l'accès n'est jamais lu", async () => {
		const t1 = setup(loadFixture("facebook/item-page.html"), FB_ITEM);
		await t1.controller.refresh();
		const t2 = setup(
			loadFixture("twh/search.html"),
			"https://www.2ememain.be/",
		);
		await t2.controller.refresh();
		expect(t1.ai.access).not.toHaveBeenCalled();
		expect(t2.ai.access).not.toHaveBeenCalled();
		expect(t1.mountCard).not.toHaveBeenCalled();
		expect(t2.mountCard).not.toHaveBeenCalled();
	});

	test("carte ajoutée (défilement infini) : icône après 250 ms", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(6);

		// Carte neuve, tirée d'une copie vierge de la fixture.
		const source = loadFixture("facebook/grid.html").querySelector(
			'[data-virtualized="false"]',
		);
		if (!source) throw new Error("no card");
		const added = doc.importNode(source, true);
		added
			.querySelector("a")
			?.setAttribute(
				"href",
				"https://www.facebook.com/marketplace/item/9000000000000099/",
			);
		doc
			.querySelector('[data-virtualized="false"]')
			?.parentElement?.append(added);

		await vi.advanceTimersByTimeAsync(249);
		expect(t.live()).toHaveLength(6);
		await vi.advanceTimersByTimeAsync(1);
		expect(t.live()).toHaveLength(7);
		expect(t.liveOf("9000000000000099").card.element.isConnected).toBe(true);
		expect(t.ai.access).toHaveBeenCalledTimes(1);
	});

	test("l'insertion de nos hôtes ne déclenche pas de refresh", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		const calls = t.getLocale.mock.calls.length;
		await vi.advanceTimersByTimeAsync(500);
		expect(t.getLocale.mock.calls.length).toBe(calls);
	});

	test("R4 : un href reçu plus tard (hydratation) donne une icône après 250 ms", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("twh/search.html");
		const links = [
			...doc.querySelectorAll('a[href*="/m1000000103-"]'),
		] as HTMLAnchorElement[];
		const hrefs = links.map((a) => a.getAttribute("href") as string);
		for (const a of links) a.removeAttribute("href");
		const t = setup(doc, TWH_SEARCH);
		await t.controller.refresh();
		expect(t.live().map((m) => m.card.externalId)).not.toContain("m1000000103");

		links.forEach((a, i) => {
			a.setAttribute("href", hrefs[i] as string);
		});
		await vi.advanceTimersByTimeAsync(250);
		expect(
			t.liveOf("m1000000103").card.element.contains(links[0] ?? null),
		).toBe(true);
		expect(t.live()).toHaveLength(6);
	});

	test("passage à une fiche : aucune icône ne reste", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(6);

		t.navigate(FB_ITEM);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(0);
		expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(0);
		expect(marked(doc)).toEqual([]);
	});

	test("nouvelle page de recherche (locationchange) : l'accès est relu", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		t.navigate(
			"https://www.facebook.com/marketplace/brussels/search/?query=velo",
		);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(2);
	});

	test("langue changée : nouveau rendu sans remontage", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		t.setLocale("nl");
		await t.controller.refresh();
		expect(t.mountCard).toHaveBeenCalledTimes(6);
		for (const id of FB_IDS) expect(t.lastView(id).locale).toBe("nl");
	});

	test("dispose retire toutes les icônes", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		t.controller.dispose();
		expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(0);
		expect(marked(doc)).toEqual([]);
	});
});

describe("createCardController — remontage (R4)", () => {
	test("hôte retiré par le site : remonté, l'état du scan est conservé", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		const first = t.liveOf(id);
		t.lastView(id).onActivate();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.lastView(id).state).toEqual({
			status: "done",
			result: sampleAnalysis,
		});

		first.host.remove();
		await vi.advanceTimersByTimeAsync(250);
		const second = t.liveOf(id);
		expect(second).not.toBe(first);
		expect(first.unmounted).toBe(true);
		expect(second.anchor).toBe(first.anchor);
		expect(second.views[0]?.state).toEqual({
			status: "done",
			result: sampleAnalysis,
		});
		expect(t.mountCard).toHaveBeenCalledTimes(7);
	});

	test("ancre changée (autre variante de mise en page) : remontée à la nouvelle ancre, état conservé", async () => {
		const doc = loadFixture("twh/search.html");
		const t = setup(doc, TWH_SEARCH);
		t.scan.mockResolvedValue({ ok: false, error: { code: "rate_limited" } });
		await t.controller.refresh();
		const id = TWH_IDS[0] as string;
		const first = t.liveOf(id);
		t.lastView(id).onActivate();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "error",
				code: "rate_limited",
			}),
		);

		const [desktop, tablet] =
			first.card.element.querySelectorAll('a[href*="/v/"]');
		if (!desktop || !tablet) throw new Error("no layout variants");
		expect(desktop.contains(first.anchor)).toBe(true);
		desktop.checkVisibility = () => false;
		await t.controller.refresh();

		const second = t.liveOf(id);
		expect(first.unmounted).toBe(true);
		expect(tablet.contains(second.anchor)).toBe(true);
		expect(second.views[0]?.state).toEqual({
			status: "error",
			code: "rate_limited",
		});
		expect(second.card.element.getAttribute("data-radarnaque-card")).toBe(id);
	});
});

describe("createCardController — clic et scan", () => {
	test("clic : loading puis done ; scan avec la carte, l'adaptateur et l'URL", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		const pending = deferred<BgResponse<AnalysisResult>>();
		t.scan.mockReturnValueOnce(pending.promise);
		await t.controller.refresh();
		const id = FB_IDS[1] as string;
		t.lastView(id).onActivate();

		expect(t.lastView(id).state).toEqual({ status: "loading" });
		expect(t.scan).toHaveBeenCalledTimes(1);
		const [card, deps] = t.scan.mock.calls[0] ?? [];
		expect(card?.externalId).toBe(id);
		expect(card?.element).toBe(t.liveOf(id).card.element);
		expect(deps?.adapter.id).toBe("facebook");
		expect(deps?.pageUrl.href).toBe(FB_SEARCH);
		expect(deps?.ai).toBe(t.ai);
		expect(deps?.fetchPage).toBe(t.fetchPage);

		// Second clic pendant le chargement : ignoré.
		t.lastView(id).onActivate();
		expect(t.scan).toHaveBeenCalledTimes(1);

		pending.resolve({ ok: true, data: sampleAnalysis });
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "done",
				result: sampleAnalysis,
			}),
		);
		// Clic après done : rien.
		t.lastView(id).onActivate();
		expect(t.scan).toHaveBeenCalledTimes(1);
		// Les autres cartes restent inactives.
		expect(t.lastView(FB_IDS[0] as string).state).toEqual({ status: "idle" });
	});

	test("clic après une erreur : nouvelle tentative", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		t.scan.mockResolvedValueOnce({
			ok: false,
			error: { code: "analysis_failed" },
		});
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "error",
				code: "analysis_failed",
			}),
		);
		t.lastView(id).onActivate();
		expect(t.scan).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(t.lastView(id).state.status).toBe("done"));
		// Pas de session expirée : l'accès n'est pas relu.
		expect(t.ai.access).toHaveBeenCalledTimes(1);
	});

	test("scan qui rejette : erreur background_unavailable", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		t.scan.mockRejectedValueOnce(new Error("boom"));
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "error",
				code: "background_unavailable",
			}),
		);
	});

	test.each(["session_expired", "unauthenticated"])(
		"%s : l'accès est relu, signedOut retire toutes les icônes",
		async (code) => {
			const doc = loadFixture("facebook/grid.html");
			const t = setup(doc, FB_SEARCH);
			t.scan.mockResolvedValueOnce({ ok: false, error: { code } });
			await t.controller.refresh();
			t.setAccess(signedOut);
			t.lastView(FB_IDS[0] as string).onActivate();
			await vi.waitFor(() => expect(t.ai.access).toHaveBeenCalledTimes(2));
			await t.controller.refresh();
			expect(t.live()).toHaveLength(0);
			expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(0);
		},
	);
});

describe("createCardController — accès inactif relu (R5)", () => {
	test("signedOut puis focus avec un accès actif : les icônes apparaissent", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [signedOut, withCards]);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(0);

		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(t.live()).toHaveLength(6));
		expect(t.ai.access).toHaveBeenCalledTimes(2);
	});

	test("visibilitychange vers visible : accès relu ; masqué : non", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [{ status: "noSubscription" }, withCards]);
		await t.controller.refresh();
		let state: DocumentVisibilityState = "hidden";
		Object.defineProperty(doc, "visibilityState", {
			configurable: true,
			get: () => state,
		});
		doc.dispatchEvent(new Event("visibilitychange"));
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(1);

		state = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => expect(t.live()).toHaveLength(6));
		expect(t.ai.access).toHaveBeenCalledTimes(2);
	});

	test("accès actif : focus ne relit pas l'accès", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		window.dispatchEvent(new Event("focus"));
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(1);
	});

	test("hors page de recherche : focus ne lit pas l'accès", async () => {
		const t = setup(loadFixture("facebook/item-page.html"), FB_ITEM);
		await t.controller.refresh();
		window.dispatchEvent(new Event("focus"));
		await t.controller.refresh();
		expect(t.ai.access).not.toHaveBeenCalled();
	});
});
