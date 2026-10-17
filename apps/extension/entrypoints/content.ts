import "../components/badge.css";
import type { Locale } from "@radarnaque/shared";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import {
	createShadowRootUi,
	type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";
import { defineContentScript } from "wxt/utils/define-content-script";
import { RiskBadge } from "../components/RiskBadge";
import {
	BADGE_HOST_TAG,
	createController,
	type Mounter,
} from "../lib/content/controller";
import { resolveContentLocale } from "../lib/content-i18n";
import type { Site } from "../lib/listing/types";
import type { RiskReport } from "../lib/rules/score";
import { localePref } from "../lib/storage";

/**
 * Pastille dans un shadow root, insérée après l'ancre. `createShadowRootUi` est
 * asynchrone (chargement du CSS de l'extension) : un `unmount` arrivé avant la
 * fin de la création annule le montage.
 */
function createBadgeMounter(ctx: ContentScriptContext): Mounter {
	let ui: ShadowRootContentScriptUi<Root> | null = null;
	let report: RiskReport | null = null;
	let locale: Locale = "fr";
	let generation = 0;

	const render = (root: Root) => {
		if (report) root.render(createElement(RiskBadge, { report, locale }));
	};

	return {
		mount(anchor, nextReport, nextLocale) {
			const current = ++generation;
			report = nextReport;
			locale = nextLocale;
			void createShadowRootUi<Root>(ctx, {
				name: BADGE_HOST_TAG,
				position: "inline",
				anchor,
				append: "after",
				onMount(container) {
					const root = createRoot(container);
					render(root);
					return root;
				},
				onRemove(root) {
					root?.unmount();
				},
			}).then((created) => {
				if (current !== generation) return;
				ui = created;
				created.mount();
			});
		},
		update(nextReport) {
			report = nextReport;
			if (ui?.mounted) render(ui.mounted);
		},
		unmount() {
			generation++;
			ui?.remove();
			ui = null;
			report = null;
		},
	};
}

async function getLocale(site: Site): Promise<Locale> {
	return resolveContentLocale(
		site,
		await localePref.getValue(),
		navigator.language,
	);
}

export default defineContentScript({
	matches: [
		"*://*.2ememain.be/*",
		"*://*.2dehands.be/*",
		"*://*.facebook.com/*",
	],
	cssInjectionMode: "ui",
	runAt: "document_idle",
	main(ctx) {
		const controller = createController({
			doc: document,
			getUrl: () => new URL(location.href),
			mounter: createBadgeMounter(ctx),
			getLocale,
		});
		ctx.addEventListener(window, "wxt:locationchange", () => {
			void controller.refresh();
		});
		ctx.onInvalidated(controller.dispose);
		void controller.refresh();
	},
});
