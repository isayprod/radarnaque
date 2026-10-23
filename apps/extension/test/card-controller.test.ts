import type {
	AnalysisResult,
	Locale,
	ScanProgressEvent,
} from "@radarnaque/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { facebookAdapter } from "../lib/adapters/facebook";
import { twhAdapter } from "../lib/adapters/twh";
import type { CardRef } from "../lib/adapters/types";
import {
	ACTIVE_TTL_MS,
	type AccessCache,
	createAccessCache,
	RECHECK_MS,
} from "../lib/content/access-policy";
import type { AiClient } from "../lib/content/ai-client";
import {
	AI_RESULT_TTL_MS,
	type AiResultStore,
	createAiResultStore,
	listingFingerprint,
	NO_REMAINING,
	type StoredAiEntry,
	type StoredAiResult,
} from "../lib/content/ai-results";
import {
	CARD_HOST_TAG,
	type CardMount,
	type CardView,
	createCardController,
} from "../lib/content/card-controller";
import type { scanCard } from "../lib/content/card-scan";
import {
	createDebugLog,
	type DebugLog,
	type DebugSink,
} from "../lib/debug-log";
import type { BgResponse, ContentAccess } from "../lib/messages";
import {
	debugAnalysis,
	loadFixture,
	sampleAnalysis,
	sampleIdentification,
} from "./helpers";

const FB_SEARCH = "https://www.facebook.com/marketplace/brussels/";
const FB_ITEM = "https://www.facebook.com/marketplace/item/9000000000000001/";
// item-modal.html : la fiche …07 en modale, deux cartes de la grille derrière.
const FB_MODAL_ITEM =
	"https://www.facebook.com/marketplace/item/9000000000000007/";
const FB_MODAL_GRID_IDS = ["9000000000000002", "9000000000000004"];
const TWH_SEARCH = "https://www.2ememain.be/q/iphone/";
const FB_IDS = [1, 2, 3, 4, 5, 6].map((n) => `900000000000000${n}`);
const TWH_IDS = [101, 102, 103, 104, 105, 106].map((n) => `m1000000${n}`);

const withCards: ContentAccess = {
	status: "active",
	features: ["card_icons"],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
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
				// Comme `checkVisibility` : faux sous un ancêtre masqué (variante de
				// mise en page cachée, simulée par un `checkVisibility` propre).
				isVisible: () => {
					for (let el = host.parentElement; el; el = el.parentElement)
						if (Object.hasOwn(el, "checkVisibility") && !el.checkVisibility())
							return false;
					return true;
				},
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

/** Progression gardée par une analyse terminée après un clic. */
const SCANNED = expect.objectContaining({ steps: expect.any(Array) });

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

interface SetupOptions {
	accessCache?: AccessCache;
	/** Vrai : le vrai `scanCard`, qui appelle `ai.scan` (fiche illisible, repli sur la carte). */
	realScan?: boolean;
	aiResults?: AiResultStore;
	debugLog?: DebugLog;
}

function setup(
	doc: Document,
	initialUrl: string,
	accesses: ContentAccess[] = [withCards],
	options: SetupOptions = {},
) {
	let url = new URL(initialUrl);
	let locale: Locale = "fr";
	const queue = [...accesses];
	const ai = {
		access: vi.fn<AiClient["access"]>(async () => ({
			ok: true,
			data: (queue.length > 1 ? queue.shift() : queue[0]) as ContentAccess,
		})),
		scan: vi.fn<AiClient["scan"]>(() => ({
			done: Promise.resolve({ ok: true, data: sampleAnalysis }),
			cancel: vi.fn(),
		})),
		identify: vi.fn<AiClient["identify"]>(),
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
		scan: options.realScan ? undefined : scan,
		fetchPage,
		accessCache: options.accessCache,
		aiResults: options.aiResults,
		debugLog: options.debugLog,
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

	test("R7 : fiche ouverte en modale sur la grille : les icônes restent, aucun montage", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/item-modal.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		const before = t.live();
		expect(before.map((m) => m.card.externalId)).toEqual(FB_MODAL_GRID_IDS);

		t.navigate(FB_MODAL_ITEM);
		await t.controller.refresh();
		// Une mutation pendant la modale ne change rien non plus.
		doc.querySelector('[role="dialog"]')?.append(doc.createElement("div"));
		await vi.advanceTimersByTimeAsync(250);
		expect(t.live()).toEqual(before);
		expect(before.every((m) => m.host.isConnected)).toBe(true);
		expect(marked(doc)).toEqual(FB_MODAL_GRID_IDS);
		expect(t.mountCard).toHaveBeenCalledTimes(2);

		// Modale fermée, retour à la grille : les mêmes icônes, aucun remontage.
		t.navigate(FB_SEARCH);
		await t.controller.refresh();
		expect(t.live()).toEqual(before);
		expect(t.mountCard).toHaveBeenCalledTimes(2);
	});

	test("R7 : fiche en modale sans grille derrière : les icônes sont retirées", async () => {
		const doc = loadFixture("facebook/item-modal.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(2);
		for (const m of t.live()) m.card.element.remove();
		t.navigate(FB_MODAL_ITEM);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(0);
	});

	test("R8 : accès actif gardé 5 min d'une URL à l'autre, relu ensuite", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		t.navigate(`${FB_SEARCH}search/?query=velo`);
		await t.controller.refresh();
		t.navigate(FB_ITEM);
		await t.controller.refresh();
		t.navigate(FB_SEARCH);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(1);
		expect(t.live()).toHaveLength(6);

		await vi.advanceTimersByTimeAsync(ACTIVE_TTL_MS);
		// Même URL : pas une occasion de relire.
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(1);
		t.navigate(`${FB_SEARCH}search/?query=x`);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(2);
	});

	test("R8 : nouvelle URL, signedOut relu sans délai, noSubscription au plus toutes les 30 s", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [signedOut]);
		await t.controller.refresh();
		t.navigate(`${FB_SEARCH}search/?query=a`);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(2);

		t.setAccess({ status: "noSubscription" });
		t.navigate(`${FB_SEARCH}search/?query=b`);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(3);
		t.navigate(`${FB_SEARCH}search/?query=c`);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		t.navigate(`${FB_SEARCH}search/?query=d`);
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(4);
	});

	test("R8 : cache partagé, un accès actif déjà lu (pastille) évite la lecture", async () => {
		const accessCache = createAccessCache();
		accessCache.settle(accessCache.begin(), withCards);
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { accessCache });
		await t.controller.refresh();
		expect(t.ai.access).not.toHaveBeenCalled();
		expect(t.live()).toHaveLength(6);
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
			progress: SCANNED,
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
			progress: SCANNED,
		});
		expect(t.mountCard).toHaveBeenCalledTimes(7);
	});

	test("M1 : hôte retiré à chaque passage, au plus 3 remontages", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		const mountsOf = () => t.mounts.filter((m) => m.card.externalId === id);

		for (let i = 0; i < 6; i++) {
			for (const m of mountsOf()) m.host.remove();
			await vi.advanceTimersByTimeAsync(250);
		}
		expect(mountsOf()).toHaveLength(4);
		// Les autres cartes ne sont pas touchées.
		expect(t.mountCard).toHaveBeenCalledTimes(6 + 3);

		// Nouvelle URL : nouveau budget.
		t.navigate("https://www.facebook.com/marketplace/brussels/search/?query=x");
		await t.controller.refresh();
		expect(mountsOf()).toHaveLength(5);
	});

	test("budget neuf après une page hors résultats : recherche → fiche → même recherche", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		const mountsOf = () => t.mounts.filter((m) => m.card.externalId === id);
		const removeEachPass = async (passes: number) => {
			for (let i = 0; i < passes; i++) {
				for (const m of mountsOf()) m.host.remove();
				await vi.advanceTimersByTimeAsync(250);
			}
		};
		await removeEachPass(6);
		expect(mountsOf()).toHaveLength(4);

		t.navigate(FB_ITEM);
		await t.controller.refresh();
		t.navigate(FB_SEARCH);
		await t.controller.refresh();
		expect(mountsOf()).toHaveLength(5);
		await removeEachPass(6);
		expect(mountsOf()).toHaveLength(8);
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

describe("createCardController — aucun scan sans clic", () => {
	test("montage, refresh, mutations, focus, langue : ai.scan jamais appelé ; un clic, un appel", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { realScan: true });
		await t.controller.refresh();
		expect(t.live()).toHaveLength(6);
		await t.controller.refresh();
		t.live()[2]?.host.remove();
		doc.body.append(doc.createElement("div"));
		await vi.advanceTimersByTimeAsync(250);
		window.dispatchEvent(new Event("focus"));
		t.setLocale("nl");
		await t.controller.refresh();
		t.navigate(`${FB_SEARCH}search/?query=velo`);
		await t.controller.refresh();
		expect(t.live()).toHaveLength(6);
		expect(t.ai.scan).not.toHaveBeenCalled();
		expect(t.fetchPage).not.toHaveBeenCalled();

		t.lastView(FB_IDS[0] as string).onActivate();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.fetchPage).toHaveBeenCalledTimes(1);
		expect(t.ai.scan).toHaveBeenCalledTimes(1);
		expect(t.ai.scan.mock.calls[0]?.[0]).toMatchObject({
			trigger: "card",
			listing: { externalId: FB_IDS[0] },
		});
	});
});

describe("createCardController — coût par passage", () => {
	test("2ememain : les cartes sont cherchées une seule fois par passage", async () => {
		const doc = loadFixture("twh/search.html");
		const t = setup(doc, TWH_SEARCH);
		const closest = vi.spyOn(Element.prototype, "closest");
		const cardLookups = () =>
			closest.mock.calls.filter(([sel]) => sel === 'li, [role="listitem"]')
				.length;
		twhAdapter.findCards(doc, new URL(TWH_SEARCH));
		const once = cardLookups();
		closest.mockClear();
		await t.controller.refresh();
		expect(t.live()).toHaveLength(6);
		// Une recherche complète, plus la première carte vue par pageType.
		expect(cardLookups()).toBe(once + 1);
	});

	test.each([
		["Facebook", "facebook/grid.html", FB_SEARCH, facebookAdapter],
		["2ememain", "twh/search.html", TWH_SEARCH, twhAdapter],
	] as const)(
		"%s : ancre recalculée seulement pour une icône perdue ou une carte recréée",
		async (_, fixture, url, adapter) => {
			const doc = loadFixture(fixture);
			const t = setup(doc, url);
			const cardAnchor = vi.spyOn(adapter, "cardAnchor");
			await t.controller.refresh();
			expect(cardAnchor).toHaveBeenCalledTimes(6);

			cardAnchor.mockClear();
			await t.controller.refresh();
			await t.controller.refresh();
			expect(cardAnchor).not.toHaveBeenCalled();

			const lost = t.live()[0] as FakeMount;
			lost.host.remove();
			await t.controller.refresh();
			expect(cardAnchor).toHaveBeenCalledTimes(1);
			expect(cardAnchor.mock.calls[0]?.[0]).toBe(lost.card.element);
			expect(t.live()).toHaveLength(6);
		},
	);
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

		expect(t.lastView(id).state).toEqual({
			status: "loading",
			progress: expect.objectContaining({ steps: [] }),
		});
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
				progress: SCANNED,
			}),
		);
		// Clic après done : rien.
		t.lastView(id).onActivate();
		expect(t.scan).toHaveBeenCalledTimes(1);
		// Les autres cartes restent inactives.
		expect(t.lastView(FB_IDS[0] as string).state).toEqual({ status: "idle" });
	});

	test("card shows live progress while scanning", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { realScan: true });
		let emit!: (e: ScanProgressEvent) => void;
		const outcome = deferred<BgResponse<AnalysisResult>>();
		t.ai.scan.mockImplementationOnce((_req, onEvent) => {
			emit = onEvent;
			return { done: outcome.promise, cancel: vi.fn() };
		});
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(t.ai.scan).toHaveBeenCalledTimes(1));

		const photos = { type: "stage", stage: "photos", count: 1 } as const;
		const search = {
			type: "search",
			id: 1,
			query: "vélo prix",
			aspect: "price",
		} as const;
		emit(photos);
		emit(search);
		const state = t.lastView(id).state;
		expect(state.status).toBe("loading");
		if (state.status !== "loading") return;
		expect(state.progress.steps.map((s) => s.event)).toEqual([photos, search]);
		expect(state.progress.last).toEqual(search);
		// Les autres cartes ne reçoivent rien.
		expect(t.lastView(FB_IDS[1] as string).state).toEqual({ status: "idle" });

		outcome.resolve({ ok: true, data: sampleAnalysis });
		await vi.waitFor(() => expect(t.lastView(id).state.status).toBe("done"));
		const done = t.lastView(id).state;
		// Le résultat garde le déroulé de l'analyse.
		expect(done.status === "done" && done.progress?.steps).toHaveLength(2);
	});

	test("dispose : l'analyse en cours est annulée, son issue ignorée", async () => {
		const doc = loadFixture("facebook/grid.html");
		const debugSink = fakeSink();
		const mem = memoryStore();
		const t = setup(doc, FB_SEARCH, [withCards], {
			realScan: true,
			aiResults: mem.store,
			debugLog: createDebugLog(() => true, debugSink.sink),
		});
		const outcome = deferred<BgResponse<AnalysisResult>>();
		const cancel = vi.fn(() =>
			outcome.resolve({ ok: false, error: { code: "cancelled" } }),
		);
		t.ai.scan.mockReturnValueOnce({ done: outcome.promise, cancel });
		await t.controller.refresh();
		t.lastView(FB_IDS[0] as string).onActivate();
		await vi.waitFor(() => expect(t.ai.scan).toHaveBeenCalledTimes(1));

		t.controller.dispose();
		expect(cancel).toHaveBeenCalledTimes(1);
		await outcome.promise;
		await t.controller.refresh();
		expect(mem.store.put).not.toHaveBeenCalled();
		expect(debugSink.groups().map((g) => g.title)).not.toContain(
			"[Radarnaque debug] scan reçu",
		);
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
		"R8 %s : accès relu ; l'icône cliquée reste en erreur, les autres sont retirées, puis elle l'est à la navigation suivante",
		async (code) => {
			const accessCache = createAccessCache();
			const doc = loadFixture("facebook/grid.html");
			const t = setup(doc, FB_SEARCH, [withCards], { accessCache });
			t.scan.mockResolvedValueOnce({ ok: false, error: { code } });
			await t.controller.refresh();
			t.setAccess(signedOut);
			const id = FB_IDS[0] as string;
			t.lastView(id).onActivate();
			await vi.waitFor(() => expect(t.ai.access).toHaveBeenCalledTimes(2));
			await t.controller.refresh();
			expect(accessCache.current()).toEqual(signedOut);

			expect(t.live().map((m) => m.card.externalId)).toEqual([id]);
			expect(t.lastView(id).state).toEqual({ status: "error", code });
			expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(1);
			expect(marked(doc)).toEqual([id]);
			// D'autres passages sur la même page ne la retirent pas.
			await t.controller.refresh();
			expect(t.live().map((m) => m.card.externalId)).toEqual([id]);

			t.navigate(`${FB_SEARCH}search/?query=velo`);
			await t.controller.refresh();
			expect(t.live()).toHaveLength(0);
			expect(doc.querySelectorAll(CARD_HOST_TAG)).toHaveLength(0);
			expect(marked(doc)).toEqual([]);
		},
	);

	test("R8 : session expirée puis reconnexion (focus) : toutes les icônes, la carte cliquée revient à idle", async () => {
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		t.scan.mockResolvedValueOnce({
			ok: false,
			error: { code: "session_expired" },
		});
		await t.controller.refresh();
		t.setAccess(signedOut);
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(t.ai.access).toHaveBeenCalledTimes(2));
		await t.controller.refresh();
		expect(t.live()).toHaveLength(1);

		t.setAccess(withCards);
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(t.live()).toHaveLength(6));
		expect(t.lastView(id).state).toEqual({ status: "idle" });
	});
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
		const t = setup(doc, FB_SEARCH, [signedOut, withCards]);
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

	test.each([
		["noSubscription", { ok: true, data: { status: "noSubscription" } }],
		["en erreur", { ok: false, error: { code: "background_unavailable" } }],
	] as const)(
		"M2 : accès %s, au plus une relecture toutes les 30 s",
		async (_, first) => {
			vi.useFakeTimers();
			const doc = loadFixture("facebook/grid.html");
			const t = setup(doc, FB_SEARCH);
			t.ai.access.mockResolvedValueOnce(first as BgResponse<ContentAccess>);
			await t.controller.refresh();
			expect(t.live()).toHaveLength(0);

			// Trop tôt : pas de relecture.
			await vi.advanceTimersByTimeAsync(29_000);
			window.dispatchEvent(new Event("focus"));
			await t.controller.refresh();
			expect(t.ai.access).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1_000);
			window.dispatchEvent(new Event("focus"));
			await t.controller.refresh();
			expect(t.ai.access).toHaveBeenCalledTimes(2);
			expect(t.live()).toHaveLength(6);
		},
	);

	test("M2 : signedOut, relecture immédiate à chaque focus", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [signedOut]);
		await t.controller.refresh();
		for (let i = 0; i < 3; i++) {
			window.dispatchEvent(new Event("focus"));
			await t.controller.refresh();
		}
		expect(t.ai.access).toHaveBeenCalledTimes(4);
	});

	test("R8 : accès actif, focus ne relit pas l'accès avant 5 min", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH);
		await t.controller.refresh();
		window.dispatchEvent(new Event("focus"));
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(ACTIVE_TTL_MS);
		window.dispatchEvent(new Event("focus"));
		await t.controller.refresh();
		expect(t.ai.access).toHaveBeenCalledTimes(2);
	});

	test("hors page de recherche : focus ne lit pas l'accès", async () => {
		const t = setup(loadFixture("facebook/item-page.html"), FB_ITEM);
		await t.controller.refresh();
		window.dispatchEvent(new Event("focus"));
		await t.controller.refresh();
		expect(t.ai.access).not.toHaveBeenCalled();
	});
});

/** Magasin réel sur un stockage en mémoire, avec une horloge réglable. */
function memoryStore(initial: Record<string, StoredAiEntry> = {}) {
	let value = initial;
	let clock = Date.parse(sampleAnalysis.analyzedAt);
	const getValue = vi.fn(async () => value);
	const store = createAiResultStore(
		{
			getValue,
			setValue: async (next) => {
				value = next;
			},
		},
		() => clock,
	);
	const spied = {
		get: vi.fn<AiResultStore["get"]>((site, id) => store.get(site, id)),
		put: vi.fn<AiResultStore["put"]>((site, id, e) => store.put(site, id, e)),
		prune: vi.fn<AiResultStore["prune"]>(() => store.prune()),
		forgetIdentifiedByUser: vi.fn<AiResultStore["forgetIdentifiedByUser"]>(
			(site, id, fingerprint) =>
				store.forgetIdentifiedByUser(site, id, fingerprint),
		),
	};
	return {
		store: spied,
		getValue,
		value: () => value,
		advance(ms: number) {
			clock += ms;
		},
	};
}

/** Résultat partiel venu d'une carte, avec une empreinte qui ne correspond à rien. */
const partialEntry = (
	overrides: Partial<StoredAiResult> = {},
): StoredAiResult => ({
	result: { ...sampleAnalysis, partial: true },
	identification: null,
	identifiedByUser: false,
	fingerprint: "autre empreinte",
	storedAt: Date.parse(sampleAnalysis.analyzedAt),
	...overrides,
});

/** Résultat tel qu'adopté : sans le quota restant de l'époque (I1). */
const adopted = { ...sampleAnalysis, remaining: NO_REMAINING };

describe("createCardController — résultats gardés 24 h", () => {
	test("stored entry reused for card", async () => {
		// Analysée sur la fiche (pastille), entrée complète : l'icône la reprend telle quelle.
		const id = FB_IDS[4] as string;
		const mem = memoryStore({
			[`facebook.com|${id}`]: {
				v: 3,
				...partialEntry({
					result: { ...sampleAnalysis, remaining: { scans: 3 } },
				}),
			},
		});
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], {
			realScan: true,
			aiResults: mem.store,
		});
		await t.controller.refresh();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "done",
				result: adopted,
				progress: null,
			}),
		);
		t.lastView(id).onActivate();
		expect(t.ai.scan).not.toHaveBeenCalled();
	});

	test("entrée stockée : icône montée puis done sans clic, ai.scan jamais appelé", async () => {
		const id = FB_IDS[2] as string;
		const mem = memoryStore({
			[`facebook.com|${id}`]: { v: 3, ...partialEntry() },
		});
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], {
			realScan: true,
			aiResults: mem.store,
		});
		await t.controller.refresh();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "done",
				result: { ...adopted, partial: true },
				progress: null,
			}),
		);
		expect(mem.store.get).toHaveBeenCalledWith("facebook.com", id);
		expect(t.lastView(FB_IDS[0] as string).state).toEqual({ status: "idle" });
		// Terminé : un clic ne lance rien.
		t.lastView(id).onActivate();
		await t.controller.refresh();
		expect(t.ai.scan).not.toHaveBeenCalled();
		expect(t.fetchPage).not.toHaveBeenCalled();
	});

	test("entrée expirée : l'icône reste idle", async () => {
		const id = FB_IDS[2] as string;
		const mem = memoryStore({
			[`facebook.com|${id}`]: { v: 3, ...partialEntry() },
		});
		mem.advance(AI_RESULT_TTL_MS + 1_000);
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { aiResults: mem.store });
		await t.controller.refresh();
		await vi.waitFor(() => expect(mem.store.get).toHaveBeenCalledTimes(6));
		await t.controller.refresh();
		expect(t.lastView(id).state).toEqual({ status: "idle" });
	});

	test("après un scan de carte réussi : entrée écrite (une seule place), empreinte de l'annonce analysée", async () => {
		const mem = memoryStore();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], {
			realScan: true,
			aiResults: mem.store,
		});
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(mem.store.put).toHaveBeenCalledTimes(1));
		const scanned = t.ai.scan.mock.calls[0]?.[0];
		expect(mem.store.put).toHaveBeenCalledWith("facebook.com", id, {
			result: sampleAnalysis,
			identification: null,
			identifiedByUser: false,
			fingerprint: listingFingerprint(scanned?.listing as never),
			storedAt: expect.any(Number),
		});
	});

	test("card scan stores the identification with the analysis", async () => {
		const mem = memoryStore();
		const doc = loadFixture("facebook/grid.html");
		const withProduct = {
			...sampleAnalysis,
			identification: sampleIdentification,
		};
		const t = setup(doc, FB_SEARCH, [withCards], {
			realScan: true,
			aiResults: mem.store,
		});
		t.ai.scan.mockReturnValue({
			done: Promise.resolve({ ok: true, data: withProduct }),
			cancel: vi.fn(),
		});
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(mem.store.put).toHaveBeenCalledTimes(1));
		expect(mem.store.put).toHaveBeenCalledWith(
			"facebook.com",
			id,
			expect.objectContaining({
				result: withProduct,
				identification: sampleIdentification,
				identifiedByUser: false,
			}),
		);
	});

	test("scan de carte en échec : rien n'est écrit", async () => {
		const mem = memoryStore();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], {
			realScan: true,
			aiResults: mem.store,
		});
		t.ai.scan.mockReturnValueOnce({
			done: Promise.resolve({ ok: false, error: { code: "rate_limited" } }),
			cancel: vi.fn(),
		});
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toMatchObject({ status: "error" }),
		);
		expect(mem.store.put).not.toHaveBeenCalled();
	});

	test("remontage d'une icône idle : le magasin est relu (entrée écrite entre-temps)", async () => {
		const id = FB_IDS[3] as string;
		const mem = memoryStore();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { aiResults: mem.store });
		await t.controller.refresh();
		await vi.waitFor(() => expect(mem.store.get).toHaveBeenCalledTimes(6));
		expect(t.lastView(id).state).toEqual({ status: "idle" });

		// Analysée sur la fiche entre-temps, puis l'hôte retiré par le site.
		await mem.store.put(
			"facebook.com",
			id,
			partialEntry({ result: sampleAnalysis }),
		);
		t.liveOf(id).host.remove();
		await t.controller.refresh();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "done",
				result: adopted,
				progress: null,
			}),
		);
		expect(t.ai.scan).not.toHaveBeenCalled();
	});

	test("I1 : quota restant d'une ancienne entrée jamais repris", async () => {
		const id = FB_IDS[1] as string;
		const stored = partialEntry({
			result: { ...sampleAnalysis, remaining: { scans: 3 } },
		});
		const store: AiResultStore = {
			get: vi.fn(async (_site, cardId) => (cardId === id ? stored : null)),
			put: vi.fn(async () => {}),
			prune: vi.fn(async () => {}),
			forgetIdentifiedByUser: vi.fn(async () => {}),
		};
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { aiResults: store });
		await t.controller.refresh();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "done",
				result: adopted,
				progress: null,
			}),
		);
	});

	test("M2 : six icônes montées, une seule lecture du stockage", async () => {
		const mem = memoryStore();
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { aiResults: mem.store });
		await t.controller.refresh();
		await vi.waitFor(() => expect(mem.store.get).toHaveBeenCalledTimes(6));
		await t.controller.refresh();
		expect(mem.getValue).toHaveBeenCalledTimes(1);
	});

	test("clic pendant la lecture du magasin : la lecture tardive n'écrase pas le scan", async () => {
		const id = FB_IDS[0] as string;
		const pending = deferred<StoredAiResult | null>();
		const mem = memoryStore();
		mem.store.get.mockImplementation(async (_site, cardId) =>
			cardId === id ? pending.promise : null,
		);
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { aiResults: mem.store });
		const scanning = deferred<BgResponse<AnalysisResult>>();
		t.scan.mockReturnValueOnce(scanning.promise);
		await t.controller.refresh();
		t.lastView(id).onActivate();
		pending.resolve(partialEntry());
		await t.controller.refresh();
		expect(t.lastView(id).state).toEqual({
			status: "loading",
			progress: expect.objectContaining({ steps: [] }),
		});
	});

	test("magasin indisponible : icônes idle, le clic fonctionne", async () => {
		const failing: AiResultStore = {
			get: vi.fn(async () => {
				throw new Error("indisponible");
			}),
			put: vi.fn(async () => {
				throw new Error("indisponible");
			}),
			prune: vi.fn(async () => {}),
			forgetIdentifiedByUser: vi.fn(async () => {}),
		};
		const doc = loadFixture("facebook/grid.html");
		const t = setup(doc, FB_SEARCH, [withCards], { aiResults: failing });
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		expect(t.lastView(id).state).toEqual({ status: "idle" });
		t.lastView(id).onActivate();
		await vi.waitFor(() =>
			expect(t.lastView(id).state).toEqual({
				status: "done",
				result: sampleAnalysis,
				progress: SCANNED,
			}),
		);
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

describe("createCardController — logs de debug (superuser)", () => {
	test("le logger est passé au scan de la carte, et le résultat reçu est journalisé avec debug", async () => {
		const doc = loadFixture("facebook/grid.html");
		const { sink, groups } = fakeSink();
		const debugLog = createDebugLog(() => true, sink);
		const t = setup(doc, FB_SEARCH, [withCards], { debugLog });
		t.scan.mockResolvedValue({ ok: true, data: debugAnalysis });
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(t.lastView(id).state.status).toBe("done"));

		expect(t.scan.mock.calls[0]?.[1].debugLog).toBe(debugLog);
		expect(groups()).toEqual([
			{ title: "[Radarnaque debug] scan reçu", data: debugAnalysis },
		]);
	});

	test("erreur du scan : scan reçu avec le code d'erreur", async () => {
		const doc = loadFixture("facebook/grid.html");
		const { sink, groups } = fakeSink();
		const t = setup(doc, FB_SEARCH, [withCards], {
			debugLog: createDebugLog(() => true, sink),
		});
		t.scan.mockResolvedValue({ ok: false, error: { code: "rate_limited" } });
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(t.lastView(id).state.status).toBe("error"));
		expect(groups()).toEqual([
			{
				title: "[Radarnaque debug] scan reçu",
				data: { error: "rate_limited" },
			},
		]);
	});

	test("utilisateur standard : aucun log", async () => {
		const doc = loadFixture("facebook/grid.html");
		const { sink } = fakeSink();
		const t = setup(doc, FB_SEARCH, [withCards], {
			debugLog: createDebugLog(() => false, sink),
		});
		await t.controller.refresh();
		const id = FB_IDS[0] as string;
		t.lastView(id).onActivate();
		await vi.waitFor(() => expect(t.lastView(id).state.status).toBe("done"));
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
	});
});
