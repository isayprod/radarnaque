import { describe, expect, test, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { detachedUiContext } from "../lib/content/ui-context";

/** `ctx` simulé : compte les abonnements à l'invalidation. */
function fakeCtx() {
	const onInvalidated = vi.fn(() => () => {});
	const ctx = {
		options: { cssInjectionMode: "manual" },
		onInvalidated,
	} as unknown as ContentScriptContext;
	return { ctx, onInvalidated };
}

describe("detachedUiContext", () => {
	test("N montages et retraits n'abonnent rien au vrai ctx", async () => {
		const { ctx, onInvalidated } = fakeCtx();
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
		anchor.remove();
	});

	test("garde les options du ctx (cssInjectionMode)", () => {
		const { ctx } = fakeCtx();
		expect(detachedUiContext(ctx).options).toBe(ctx.options);
	});

	test("témoin : le ctx d'origine reçoit un abonnement par UI", async () => {
		const { ctx, onInvalidated } = fakeCtx();
		await createShadowRootUi(ctx, {
			name: "radarnaque-card",
			position: "inline",
			onMount: () => undefined,
		});
		expect(onInvalidated).toHaveBeenCalledTimes(1);
	});
});
