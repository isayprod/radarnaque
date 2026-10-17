import "../components/badge.css";
import type { Locale } from "@radarnaque/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { defineContentScript } from "wxt/utils/define-content-script";
import { RiskBadge } from "../components/RiskBadge";
import {
	type BadgeRenderer,
	createBadgeMounter,
} from "../lib/content/badge-mounter";
import { createController } from "../lib/content/controller";
import { resolveContentLocale } from "../lib/content-i18n";
import type { Site } from "../lib/listing/types";
import { localePref } from "../lib/storage";

function createReactRenderer(container: HTMLElement): BadgeRenderer {
	const root = createRoot(container);
	return {
		render: (report, locale) =>
			root.render(createElement(RiskBadge, { report, locale })),
		unmount: () => root.unmount(),
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
			mounter: createBadgeMounter({
				createUi: (options) => createShadowRootUi(ctx, options),
				createRenderer: createReactRenderer,
			}),
			getLocale,
		});
		ctx.addEventListener(window, "wxt:locationchange", () => {
			void controller.refresh();
		});
		// Langue changée dans la popup : nouveau rendu de la pastille montée.
		const unwatchLocale = localePref.watch(() => {
			void controller.refresh();
		});
		ctx.onInvalidated(() => {
			unwatchLocale();
			controller.dispose();
		});
		void controller.refresh();
	},
});
