import type { Locale } from "@radarnaque/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	BADGE_HOST_TAG,
	CARD_HOST_TAG,
	createController,
	type Mounter,
} from "../lib/content/controller";
import type { BadgeView } from "../lib/content/use-ai-scan";
import {
	createDebugLog,
	type DebugLog,
	type DebugSink,
} from "../lib/debug-log";
import type { Site } from "../lib/listing/types";
import type { RiskReport } from "../lib/rules/score";
import { loadFixture } from "./helpers";

const FIXED_URL =
	"https://www.2ememain.be/v/telephonie/apple-iphone/m1000000001-iphone-14-pro-128gb";
const BIDDING_URL =
	"https://www.2ememain.be/v/vetements-femmes/chapeaux-casquettes/m1000000002-bonnet-laine-rose";
const FB_ITEM = "9000000000000007";
const FB_OTHER_ITEM = "9000000000000008";
const fbItemUrl = (id: string) =>
	`https://www.facebook.com/marketplace/item/${id}/`;
const FB_GRID_URL = "https://www.facebook.com/marketplace/";

type Op =
	| {
			op: "mount";
			anchor: Element;
			view: BadgeView;
			report: RiskReport;
			locale: Locale;
	  }
	| { op: "update"; view: BadgeView; report: RiskReport; locale: Locale }
	| { op: "unmount" };

/**
 * Mounter simulé : enregistre les appels dans l'ordre et insère un hôte vide
 * après l'ancre, comme le vrai ; `isMounted()` suit sa présence dans le document.
 */
function fakeMounter() {
	const ops: Op[] = [];
	let host: Element | null = null;
	const mounter: Mounter = {
		mount: (anchor, view, locale) => {
			ops.push({ op: "mount", anchor, view, report: view.report, locale });
			host = anchor.ownerDocument.createElement(BADGE_HOST_TAG);
			anchor.after(host);
		},
		update: (view, locale) =>
			ops.push({ op: "update", view, report: view.report, locale }),
		unmount: () => {
			ops.push({ op: "unmount" });
			host?.remove();
			host = null;
		},
		isMounted: () => host?.isConnected ?? false,
	};
	const of = <K extends Op["op"]>(kind: K) =>
		ops.filter((o): o is Extract<Op, { op: K }> => o.op === kind);
	return { mounter, ops, of, host: () => host };
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
	locale: (site: Site) => Promise<Locale> = async () => "fr",
	debugLog?: DebugLog,
) {
	let url = new URL(initialUrl);
	const fake = fakeMounter();
	const log = vi.fn<(msg: string) => void>();
	const getUrl = vi.fn(() => url);
	const getLocale = vi.fn(locale);
	const controller = createController({
		doc,
		getUrl,
		mounter: fake.mounter,
		getLocale,
		log,
		debugLog,
	});
	disposers.push(controller.dispose);
	return {
		...fake,
		controller,
		log,
		getUrl,
		getLocale,
		navigate(next: string) {
			url = new URL(next);
		},
	};
}

const signalIds = (report: RiskReport) => report.signals.map((s) => s.id);

/** Liens d'avis du vendeur dans la sidebar 2ememain. */
function removeSidebarReviews(doc: Document) {
	for (const a of doc.querySelectorAll(
		'#seller-sidebar-root a[href*="/experiences/user-reviews/"]',
	)) {
		a.parentElement?.remove();
	}
}

describe("createController — 2ememain", () => {
	test("listing-fixed : un seul mount, rapport et locale fr, même après deux refresh", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount"]);
		const [mount] = t.of("mount");
		expect(mount?.locale).toBe("fr");
		expect(mount?.report.rulesVersion).toBe(4);
		expect(mount?.anchor).toBe(doc.querySelector("#seller-sidebar-root h1"));
		expect(mount?.anchor.getAttribute("data-radarnaque")).toBe("m1000000001");
		expect(t.getLocale).toHaveBeenCalledWith("2ememain.be");
	});

	test("données vendeur arrivées après coup : update avec no_reviews, pas de second mount", async () => {
		const doc = loadFixture("twh/listing-bidding-skeleton.html");
		removeSidebarReviews(doc);
		const t = setup(doc, BIDDING_URL);
		await t.controller.refresh();
		expect(t.of("mount")).toHaveLength(1);
		expect(signalIds(t.of("mount")[0]?.report as RiskReport)).not.toContain(
			"no_reviews",
		);

		const row = doc.createElement("div");
		row.innerHTML =
			'<a href="https://www.2ememain.be/experiences/user-reviews/10000001/" role="link"><span> 0 avis</span></a>';
		doc.querySelector("#seller-sidebar-root")?.append(row);
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "update"]);
		expect(signalIds(t.of("update")[0]?.report as RiskReport)).toContain(
			"no_reviews",
		);
	});

	test("champ illisible (description) : la règle correspondante n'est pas évaluée", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		doc.querySelector('[data-collapsable="description"]')?.remove();
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		expect(signalIds(t.of("mount")[0]?.report as RiskReport)).not.toContain(
			"short_description",
		);
	});

	test("langue changée dans la popup : update avec la nouvelle locale, sans remount", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		let locale: Locale = "fr";
		const t = setup(doc, FIXED_URL, async () => locale);
		await t.controller.refresh();
		locale = "nl";
		await t.controller.refresh();
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "update"]);
		const [update] = t.of("update");
		expect(update?.locale).toBe("nl");
		expect(update?.report).toEqual(t.of("mount")[0]?.report);
	});

	test("la vue montée porte l'annonce extraite", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		const listing = t.of("mount")[0]?.view.listing;
		expect(listing?.site).toBe("2ememain.be");
		expect(listing?.externalId).toBe("m1000000001");
		expect(listing?.title).toBeTruthy();
	});

	test("description modifiée par le site : update avec la nouvelle annonce, sans remontage", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		const before = t.of("mount")[0]?.view.listing.description ?? "";

		const description = doc.querySelector('[data-collapsable="description"]');
		const node = description?.querySelector("p, div") ?? description;
		node?.append(doc.createTextNode(" Texte ajouté par le vendeur."));
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "update"]);
		const after = t.of("update")[0]?.view.listing.description;
		expect(after).not.toBe(before);
		expect(after).toContain("Texte ajouté par le vendeur.");
	});

	test("ancre déjà marquée pour cette annonce (autre instance) : pas de second mount", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		doc
			.querySelector("#seller-sidebar-root h1")
			?.setAttribute("data-radarnaque", "m1000000001");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		expect(t.ops).toEqual([]);
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

describe("createController — logs de debug (superuser)", () => {
	test("superuser : annonce extraite et analyse locale, une fois par changement", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const { sink, groups } = fakeSink();
		const t = setup(
			doc,
			FIXED_URL,
			undefined,
			createDebugLog(() => true, sink),
		);
		await t.controller.refresh();
		await t.controller.refresh();
		await t.controller.refresh();

		const mount = t.of("mount")[0];
		expect(groups().map((g) => g.title)).toEqual([
			"[Radarnaque debug] annonce extraite",
			"[Radarnaque debug] analyse locale",
		]);
		const [extracted, local] = groups();
		expect(extracted?.data).toEqual({
			listing: mount?.view.listing,
			missing: expect.any(Array),
		});
		expect(local?.data).toEqual({
			score: mount?.report.score,
			level: mount?.report.level,
			signals: mount?.report.signals,
		});

		// Annonce modifiée par le site : un nouveau couple de logs.
		const description = doc.querySelector('[data-collapsable="description"]');
		const node = description?.querySelector("p, div") ?? description;
		node?.append(doc.createTextNode(" Texte ajouté par le vendeur."));
		await t.controller.refresh();
		await t.controller.refresh();
		expect(groups()).toHaveLength(4);
		const changed = groups()[2]?.data as
			| { listing: BadgeView["listing"] }
			| undefined;
		expect(changed?.listing.description).toContain(
			"Texte ajouté par le vendeur.",
		);
	});

	test("utilisateur standard : aucun log de debug", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const { sink } = fakeSink();
		const t = setup(
			doc,
			FIXED_URL,
			undefined,
			createDebugLog(() => false, sink),
		);
		await t.controller.refresh();
		expect(t.of("mount")).toHaveLength(1);
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
		expect(sink.log).not.toHaveBeenCalled();
	});
});

describe("createController — Facebook", () => {
	test("navigation interne vers une autre annonce : unmount puis mount sur le nouveau h1", async () => {
		const doc = loadFixture("facebook/item-modal.html");
		const t = setup(doc, fbItemUrl(FB_ITEM));
		await t.controller.refresh();
		const firstAnchor = t.of("mount")[0]?.anchor;
		expect(firstAnchor?.textContent).toBe(
			"Appareil photo canon EOS 3000 avec objectif",
		);

		// Facebook remplace le contenu de la modale par l'annonce suivante.
		const dialog = doc.querySelector('[role="dialog"]') as Element;
		dialog.innerHTML = dialog.innerHTML.replaceAll(
			`product_id=${FB_ITEM}`,
			`product_id=${FB_OTHER_ITEM}`,
		);
		const title = dialog.querySelector("h1 span") as Element;
		title.textContent = "Vélo de course";
		t.navigate(fbItemUrl(FB_OTHER_ITEM));
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "unmount", "mount"]);
		const second = t.of("mount")[1];
		expect(second?.anchor).not.toBe(firstAnchor);
		expect(second?.anchor.textContent).toBe("Vélo de course");
		expect(second?.anchor.getAttribute("data-radarnaque")).toBe(FB_OTHER_ITEM);
	});

	test("photos chargées après coup : update avec les images, sans remontage", async () => {
		const doc = loadFixture("facebook/item-modal.html");
		const photos = [
			...doc.querySelectorAll('[role="dialog"] img[alt^="Photo de produit"]'),
		];
		expect(photos.length).toBeGreaterThan(0);
		const sources = photos.map((img) => img.getAttribute("src"));
		for (const img of photos) img.removeAttribute("src");
		const t = setup(doc, fbItemUrl(FB_ITEM));
		await t.controller.refresh();
		expect(t.of("mount")[0]?.view.listing.images).toEqual([]);

		photos.forEach((img, i) => {
			img.setAttribute("src", sources[i] ?? "");
		});
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "update"]);
		const update = t.of("update")[0];
		expect(update?.view.listing.images.length).toBeGreaterThan(0);
	});

	test("navigation vers la grille : unmount, sans nouveau mount", async () => {
		const doc = loadFixture("facebook/item-modal.html");
		const t = setup(doc, fbItemUrl(FB_ITEM));
		await t.controller.refresh();
		const anchor = t.of("mount")[0]?.anchor;

		t.navigate(FB_GRID_URL);
		await t.controller.refresh();
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "unmount"]);
		expect(anchor?.hasAttribute("data-radarnaque")).toBe(false);
	});

	test("h1 de l'annonce retiré : aucun mount, une seule ligne de log après 3 refresh", async () => {
		const doc = loadFixture("facebook/item-page.html");
		for (const h1 of doc.querySelectorAll('[role="main"] h1')) h1.remove();
		const t = setup(doc, fbItemUrl(FB_ITEM));
		await t.controller.refresh();
		await t.controller.refresh();
		await t.controller.refresh();

		expect(t.ops).toEqual([]);
		expect(t.log).toHaveBeenCalledTimes(1);
		expect(t.log).toHaveBeenCalledWith(
			"radarnaque: extraction impossible (facebook)",
		);
	});
});

describe("createController — observateur et cycle de vie", () => {
	test("les mutations du DOM déclenchent refresh, au plus une fois par 250 ms", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("twh/listing-bidding-skeleton.html");
		removeSidebarReviews(doc);
		const t = setup(doc, BIDDING_URL);
		await t.controller.refresh();
		// Appels à getUrl pour un passage (avant et après la lecture de la locale).
		const callsAfterStart = t.getUrl.mock.calls.length;
		const perRefresh = callsAfterStart;

		for (let i = 0; i < 5; i++) doc.body.append(doc.createElement("div"));
		await vi.advanceTimersByTimeAsync(249);
		expect(t.getUrl.mock.calls.length).toBe(callsAfterStart);
		await vi.advanceTimersByTimeAsync(1);
		expect(t.getUrl.mock.calls.length).toBe(callsAfterStart + perRefresh);
		expect(t.getLocale).toHaveBeenCalledTimes(2);

		// Appel final garanti : la mutation qui apporte les avis arrive après.
		const row = doc.createElement("div");
		row.innerHTML =
			'<a href="/experiences/user-reviews/10000001/"><span>0 avis</span></a>';
		doc.querySelector("#seller-sidebar-root")?.append(row);
		await vi.advanceTimersByTimeAsync(250);
		expect(t.ops.map((o) => o.op)).toEqual(["mount", "update"]);
	});

	test("l'insertion de notre propre hôte ne déclenche pas de refresh", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		expect(t.host()?.isConnected).toBe(true);
		const calls = t.getUrl.mock.calls.length;

		await vi.advanceTimersByTimeAsync(500);
		expect(t.getUrl.mock.calls.length).toBe(calls);
	});

	test("l'insertion d'une icône de carte ne déclenche pas de refresh", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		const calls = t.getUrl.mock.calls.length;

		doc.body.append(doc.createElement(CARD_HOST_TAG));
		await vi.advanceTimersByTimeAsync(500);
		expect(t.getUrl.mock.calls.length).toBe(calls);
	});

	test("le site retire notre hôte (même ancre) : un seul remount par URL", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		const anchor = t.of("mount")[0]?.anchor;

		// Le retrait par le site est observé : refresh, puis remount sur la même ancre.
		t.host()?.remove();
		await vi.advanceTimersByTimeAsync(250);
		expect(t.ops.map((o) => o.op)).toEqual(["mount", "unmount", "mount"]);
		expect(t.of("mount")[1]?.anchor).toBe(anchor);
		expect(anchor?.getAttribute("data-radarnaque")).toBe("m1000000001");

		// Second retrait sur la même URL : pas de nouvelle tentative (pas de boucle).
		t.host()?.remove();
		await vi.advanceTimersByTimeAsync(250);
		await t.controller.refresh();
		expect(t.of("mount")).toHaveLength(2);
	});

	test("dispose() déconnecte l'observateur et rend refresh inopérant", async () => {
		vi.useFakeTimers();
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		t.controller.dispose();

		doc.body.append(doc.createElement("div"));
		await vi.advanceTimersByTimeAsync(500);
		await t.controller.refresh();

		expect(t.getUrl).not.toHaveBeenCalled();
		expect(t.ops).toEqual([]);
	});

	test("dispose() après un mount : unmount et attribut retiré", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		const anchor = t.of("mount")[0]?.anchor;
		t.controller.dispose();
		expect(t.ops.map((o) => o.op)).toEqual(["mount", "unmount"]);
		expect(anchor?.hasAttribute("data-radarnaque")).toBe(false);
	});
});

describe("createController — concurrence et état obsolète", () => {
	test("deux refresh simultanés : un seul mount", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await Promise.all([t.controller.refresh(), t.controller.refresh()]);
		expect(t.ops.map((o) => o.op)).toEqual(["mount"]);
	});

	test("dispose() pendant getLocale : aucun mount", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const locale = deferred<Locale>();
		const t = setup(doc, FIXED_URL, () => locale.promise);
		const pending = t.controller.refresh();
		await vi.waitFor(() => expect(t.getLocale).toHaveBeenCalled());
		t.controller.dispose();
		locale.resolve("fr");
		await pending;
		expect(t.ops).toEqual([]);
		expect(
			doc
				.querySelector("#seller-sidebar-root h1")
				?.hasAttribute("data-radarnaque"),
		).toBe(false);
	});

	test("URL changée pendant getLocale : pas de mount sur l'ancienne annonce", async () => {
		const doc = loadFixture("facebook/item-modal.html");
		const locale = deferred<Locale>();
		const t = setup(doc, fbItemUrl(FB_ITEM), () => locale.promise);
		const pending = t.controller.refresh();
		await vi.waitFor(() => expect(t.getLocale).toHaveBeenCalled());
		t.navigate(FB_GRID_URL);
		locale.resolve("fr");
		await pending;
		expect(t.ops).toEqual([]);
	});

	test("ancre retirée du document pendant getLocale : pas de mount", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const locale = deferred<Locale>();
		const t = setup(doc, FIXED_URL, () => locale.promise);
		const pending = t.controller.refresh();
		await vi.waitFor(() => expect(t.getLocale).toHaveBeenCalled());
		doc.querySelector("#seller-sidebar-root h1")?.remove();
		locale.resolve("fr");
		await pending;
		expect(t.ops).toEqual([]);
	});

	test("même élément d'ancre, autre externalId : unmount puis mount", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL);
		await t.controller.refresh();
		t.navigate(
			"https://www.2ememain.be/v/telephonie/apple-iphone/m1000000003-autre-iphone",
		);
		await t.controller.refresh();

		expect(t.ops.map((o) => o.op)).toEqual(["mount", "unmount", "mount"]);
		const [first, second] = t.of("mount");
		expect(second?.anchor).toBe(first?.anchor);
		expect(second?.anchor.getAttribute("data-radarnaque")).toBe("m1000000003");
	});

	test("erreur pendant refresh : journalisée une seule fois par URL", async () => {
		const doc = loadFixture("twh/listing-fixed.html");
		const t = setup(doc, FIXED_URL, async () => {
			throw new Error("stockage indisponible");
		});
		await t.controller.refresh();
		await t.controller.refresh();
		await t.controller.refresh();
		expect(t.ops).toEqual([]);
		expect(t.log).toHaveBeenCalledTimes(1);
		expect(t.log.mock.calls[0]?.[0]).toContain("stockage indisponible");

		t.navigate(
			"https://www.2ememain.be/v/telephonie/apple-iphone/m1000000003-autre-iphone",
		);
		await t.controller.refresh();
		expect(t.log).toHaveBeenCalledTimes(2);
	});
});
