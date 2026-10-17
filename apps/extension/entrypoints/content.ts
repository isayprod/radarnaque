import "../components/badge.css";
import type { Locale } from "@radarnaque/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { defineContentScript } from "wxt/utils/define-content-script";
import { CardBadge } from "../components/CardBadge";
import { RiskBadge } from "../components/RiskBadge";
import { type AiClient, createAiClient } from "../lib/content/ai-client";
import {
	type BadgeRenderer,
	createBadgeMounter,
} from "../lib/content/badge-mounter";
import { createCardController } from "../lib/content/card-controller";
import {
	type CardRenderer,
	createCardMounter,
} from "../lib/content/card-mounter";
import { createController } from "../lib/content/controller";
import { detachedUiContext } from "../lib/content/ui-context";
import { resolveContentLocale } from "../lib/content-i18n";
import type { Site } from "../lib/listing/types";
import { localePref } from "../lib/storage";

function createReactRenderer(
	container: HTMLElement,
	ai: AiClient,
): BadgeRenderer {
	const root = createRoot(container);
	return {
		render: ({ report, listing }, locale) =>
			root.render(createElement(RiskBadge, { report, listing, locale, ai })),
		unmount: () => root.unmount(),
	};
}

/** Une racine React par icône de carte. */
function createCardRenderer(container: HTMLElement): CardRenderer {
	const root = createRoot(container);
	return {
		render: (view) => root.render(createElement(CardBadge, view)),
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
		// Un seul client IA par content script, partagé par toutes les pastilles.
		const ai = createAiClient();
		// Les UI ne s'abonnent pas à l'invalidation (une fuite par montage) : les
		// `dispose()` ci-dessous les retirent toutes.
		const uiCtx = detachedUiContext(ctx);
		const controller = createController({
			doc: document,
			getUrl: () => new URL(location.href),
			mounter: createBadgeMounter({
				createUi: (options) => createShadowRootUi(uiCtx, options),
				createRenderer: (container) => createReactRenderer(container, ai),
			}),
			getLocale,
		});
		// Icônes des cartes de résultats, à côté de la pastille de fiche.
		const cards = createCardController({
			doc: document,
			getUrl: () => new URL(location.href),
			ai,
			mountCard: createCardMounter({
				createUi: (options) => createShadowRootUi(uiCtx, options),
				createRenderer: createCardRenderer,
			}),
			getLocale,
			win: window,
		});
		ctx.addEventListener(window, "wxt:locationchange", () => {
			void controller.refresh();
			void cards.refresh();
		});
		// Langue changée dans la popup : nouveau rendu de la pastille et des icônes.
		const unwatchLocale = localePref.watch(() => {
			void controller.refresh();
			void cards.refresh();
		});
		ctx.onInvalidated(() => {
			unwatchLocale();
			controller.dispose();
			cards.dispose();
		});
		void controller.refresh();
		void cards.refresh();
	},
});
