import { afterEach, describe, expect, test, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import {
	createUiFactory,
	detachedUiContext,
	shadowCssOf,
} from "../lib/content/ui-context";

/** `ctx` simulé : compte les abonnements à l'invalidation. */
function fakeCtx(cssInjectionMode = "ui") {
	const onInvalidated = vi.fn(() => () => {});
	const ctx = {
		options: { cssInjectionMode },
		onInvalidated,
	} as unknown as ContentScriptContext;
	return { ctx, onInvalidated };
}

/** CSS d'entrée tel que Tailwind le produit : `:root`, `@property`, règles. */
const ENTRY_CSS = [
	":root,:host{--color-red-500:red}",
	'@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}',
	".shadow-sm{box-shadow:var(--tw-shadow)}",
	'@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}',
].join("\n");

afterEach(() => {
	document.head.replaceChildren();
	document.body.replaceChildren();
});

describe("detachedUiContext", () => {
	test("N montages et retraits n'abonnent rien au vrai ctx", async () => {
		const { ctx, onInvalidated } = fakeCtx("manual");
		const uiCtx = detachedUiContext(ctx);
		const anchor = document.createElement("span");
		document.body.append(anchor);
		for (let i = 0; i < 5; i++) {
			const ui = await createShadowRootUi(uiCtx, {
				name: "radarnaque-card",
				position: "inline",
				anchor,
				append: "after",
				onMount: () => undefined,
			});
			ui.mount();
			expect(anchor.nextElementSibling?.localName).toBe("radarnaque-card");
			ui.remove();
		}
		expect(onInvalidated).not.toHaveBeenCalled();
		expect(anchor.nextElementSibling).toBeNull();
	});

	test("R7 : CSS injecté à la main, quel que soit le mode de l'entrée", () => {
		const { ctx } = fakeCtx("ui");
		expect(detachedUiContext(ctx).options?.cssInjectionMode).toBe("manual");
		expect(ctx.options?.cssInjectionMode).toBe("ui");
	});

	test("témoin : le ctx d'origine reçoit un abonnement par UI", async () => {
		const { ctx, onInvalidated } = fakeCtx("manual");
		await createShadowRootUi(ctx, {
			name: "radarnaque-card",
			position: "inline",
			onMount: () => undefined,
		});
		expect(onInvalidated).toHaveBeenCalledTimes(1);
	});
});

describe("shadowCssOf", () => {
	test(":root devient :host, les blocs @property sont retirés", () => {
		const css = shadowCssOf(ENTRY_CSS);
		expect(css).not.toContain("@property");
		expect(css).not.toContain(":root");
		expect(css).toContain(":host,:host{--color-red-500:red}");
		expect(css).toContain(".shadow-sm{box-shadow:var(--tw-shadow)}");
	});
});

describe("createUiFactory (R7)", () => {
	test("N montages : CSS chargé une fois, rien dans document.head, CSS dans chaque shadow root", async () => {
		const { ctx, onInvalidated } = fakeCtx("ui");
		const loadCss = vi.fn(async () => ENTRY_CSS);
		const createUi = createUiFactory(ctx, loadCss);
		const anchor = document.createElement("span");
		document.body.append(anchor);
		const headBefore = document.head.childElementCount;

		const uis = await Promise.all(
			Array.from({ length: 5 }, () =>
				createUi({
					name: "radarnaque-card",
					position: "inline",
					anchor,
					append: "after",
					onMount: () => undefined,
				}),
			),
		);
		for (const ui of uis) ui.mount();
		for (let i = 0; i < 3; i++) {
			const ui = await createUi({
				name: "radarnaque-card",
				position: "inline",
				anchor,
				append: "after",
				onMount: () => undefined,
			});
			ui.mount();
			ui.remove();
		}

		expect(loadCss).toHaveBeenCalledTimes(1);
		expect(document.head.childElementCount).toBe(headBefore);
		expect(
			document.querySelector("style[wxt-shadow-root-document-styles]"),
		).toBeNull();
		expect(onInvalidated).not.toHaveBeenCalled();
		const style = uis[0]?.shadow.querySelector("style")?.textContent ?? "";
		expect(style).toContain(".shadow-sm{box-shadow:var(--tw-shadow)}");
		expect(style).not.toContain("@property");
		for (const ui of uis) ui.remove();
	});

	test("chargement en échec : UI montée sans CSS, nouvel essai au montage suivant", async () => {
		const { ctx } = fakeCtx("ui");
		const loadCss = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(ENTRY_CSS);
		const log = vi.fn();
		const createUi = createUiFactory(ctx, loadCss, log);
		const options = {
			name: "radarnaque-card",
			position: "inline",
			onMount: () => undefined,
		} as const;
		const first = await createUi(options);
		expect(first.shadow.querySelector("style")?.textContent).not.toContain(
			".shadow-sm",
		);
		expect(log).toHaveBeenCalledTimes(1);
		const second = await createUi(options);
		expect(second.shadow.querySelector("style")?.textContent).toContain(
			".shadow-sm",
		);
		await createUi(options);
		expect(loadCss).toHaveBeenCalledTimes(2);
	});
});
