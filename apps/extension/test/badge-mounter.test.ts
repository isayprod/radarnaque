import type { Locale } from "@radarnaque/shared";
import { describe, expect, test, vi } from "vitest";
import type { ShadowRootContentScriptUiOptions } from "wxt/utils/content-script-ui/shadow-root";
import {
	type BadgeRenderer,
	type BadgeUi,
	createBadgeMounter,
} from "../lib/content/badge-mounter";
import { BADGE_HOST_TAG } from "../lib/content/controller";
import type { RiskReport } from "../lib/rules/score";

const low: RiskReport = {
	score: 0,
	level: "low",
	signals: [],
	rulesVersion: 1,
};
const medium: RiskReport = {
	score: 35,
	level: "medium",
	rulesVersion: 1,
	signals: [{ id: "offsite_payment", weight: 35, severity: "danger" }],
};

/**
 * `createShadowRootUi` simulé : chaque appel renvoie une promesse résolue (ou
 * rejetée) à la demande ; `mount()` insère l'hôte après l'ancre comme WXT.
 */
function fakeUiFactory() {
	const calls: Array<{
		options: ShadowRootContentScriptUiOptions<BadgeRenderer>;
		resolve(): BadgeUi;
		reject(error: Error): void;
	}> = [];
	const createUi = vi.fn(
		(options: ShadowRootContentScriptUiOptions<BadgeRenderer>) =>
			new Promise<BadgeUi>((resolve, reject) => {
				calls.push({
					options,
					reject,
					resolve() {
						const anchor = options.anchor as Element;
						const host = anchor.ownerDocument.createElement(options.name);
						const shadow = host.attachShadow({ mode: "open" });
						const container = anchor.ownerDocument.createElement("div");
						shadow.append(container);
						let mounted: BadgeRenderer | undefined;
						const ui: BadgeUi = {
							shadowHost: host,
							mount: vi.fn(() => {
								anchor.after(host);
								mounted = options.onMount(container, shadow, host);
							}),
							remove: vi.fn(() => {
								options.onRemove?.(mounted);
								host.remove();
								mounted = undefined;
							}),
						};
						resolve(ui);
						return ui;
					},
				});
			}),
	);
	return { createUi, calls };
}

function fakeRenderer() {
	const renders: Array<{ report: RiskReport; locale: Locale }> = [];
	const unmount = vi.fn();
	const createRenderer = vi.fn(
		(_container: HTMLElement): BadgeRenderer => ({
			render: (report, locale) => renders.push({ report, locale }),
			unmount,
		}),
	);
	return { createRenderer, renders, unmount };
}

function setup() {
	document.body.innerHTML = "<h1>Annonce</h1>";
	const anchor = document.querySelector("h1") as Element;
	const ui = fakeUiFactory();
	const renderer = fakeRenderer();
	const log = vi.fn<(msg: string) => void>();
	const mounter = createBadgeMounter({
		createUi: ui.createUi,
		createRenderer: renderer.createRenderer,
		log,
	});
	return { anchor, ui, renderer, log, mounter };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createBadgeMounter", () => {
	test("options du shadow root : hôte nommé, inline, après l'ancre", () => {
		const t = setup();
		t.mounter.mount(t.anchor, low, "fr");
		const options = t.ui.calls[0]?.options;
		expect(options?.name).toBe(BADGE_HOST_TAG);
		expect(options?.position).toBe("inline");
		expect(options?.anchor).toBe(t.anchor);
		expect(options?.append).toBe("after");
	});

	test("mount puis unmount avant la création de l'UI : rien n'est monté", async () => {
		const t = setup();
		t.mounter.mount(t.anchor, low, "fr");
		t.mounter.unmount();
		const ui = t.ui.calls[0]?.resolve();
		await flush();

		expect(ui?.mount).not.toHaveBeenCalled();
		expect(t.renderer.createRenderer).not.toHaveBeenCalled();
		expect(document.querySelector(BADGE_HOST_TAG)).toBeNull();
		expect(t.mounter.isMounted()).toBe(false);
	});

	test("update avant la création de l'UI : le dernier rapport est rendu", async () => {
		const t = setup();
		t.mounter.mount(t.anchor, low, "nl");
		t.mounter.update(medium);
		t.ui.calls[0]?.resolve();
		await flush();

		expect(t.renderer.renders).toEqual([{ report: medium, locale: "nl" }]);
	});

	test("update après le montage : nouveau rendu, même locale", async () => {
		const t = setup();
		t.mounter.mount(t.anchor, low, "fr");
		t.ui.calls[0]?.resolve();
		await flush();
		t.mounter.update(medium);

		expect(t.renderer.renders).toEqual([
			{ report: low, locale: "fr" },
			{ report: medium, locale: "fr" },
		]);
	});

	test("isMounted() suit la présence de l'hôte dans le document", async () => {
		const t = setup();
		expect(t.mounter.isMounted()).toBe(false);
		t.mounter.mount(t.anchor, low, "fr");
		expect(t.mounter.isMounted()).toBe(true); // création en cours
		t.ui.calls[0]?.resolve();
		await flush();
		expect(t.anchor.nextElementSibling?.localName).toBe(BADGE_HOST_TAG);
		expect(t.mounter.isMounted()).toBe(true);

		document.querySelector(BADGE_HOST_TAG)?.remove(); // retiré par le site
		expect(t.mounter.isMounted()).toBe(false);
	});

	test("unmount après le montage : UI retirée et racine React démontée", async () => {
		const t = setup();
		t.mounter.mount(t.anchor, low, "fr");
		const ui = t.ui.calls[0]?.resolve();
		await flush();
		t.mounter.unmount();

		expect(ui?.remove).toHaveBeenCalledTimes(1);
		expect(t.renderer.unmount).toHaveBeenCalledTimes(1);
		expect(document.querySelector(BADGE_HOST_TAG)).toBeNull();
		expect(t.mounter.isMounted()).toBe(false);
	});

	test("échec de création : pas monté, une seule ligne de log", async () => {
		const t = setup();
		t.mounter.mount(t.anchor, low, "fr");
		t.ui.calls[0]?.reject(new Error("CSS introuvable"));
		await flush();
		expect(t.mounter.isMounted()).toBe(false);

		t.mounter.unmount();
		t.mounter.mount(t.anchor, low, "fr");
		t.ui.calls[1]?.reject(new Error("CSS introuvable"));
		await flush();

		expect(t.mounter.isMounted()).toBe(false);
		expect(t.log).toHaveBeenCalledTimes(1);
		expect(t.log.mock.calls[0]?.[0]).toContain("CSS introuvable");
	});
});
