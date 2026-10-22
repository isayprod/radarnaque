import "../components/badge.css";
import type { Locale } from "@radarnaque/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { browser, type PublicPath } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { CardBadge } from "../components/CardBadge";
import { RiskBadge } from "../components/RiskBadge";
import {
	type AccessCache,
	createAccessCache,
	isDebugCached,
} from "../lib/content/access-policy";
import { type AiClient, createAiClient } from "../lib/content/ai-client";
import {
	type AiResultStore,
	createAiResultStore,
} from "../lib/content/ai-results";
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
import { createDebugFlag, disabledDebugFlag } from "../lib/content/debug-flag";
import { loadFonts } from "../lib/content/fonts";
import { CONTENT_MATCHES } from "../lib/content/matches";
import { createUiFactory } from "../lib/content/ui-context";
import { resolveContentLocale } from "../lib/content-i18n";
import { createDebugLog, type DebugLog } from "../lib/debug-log";
import type { Site } from "../lib/listing/types";
import { sendToBackground } from "../lib/messages";
import { localePref } from "../lib/storage";

function createReactRenderer(
	container: HTMLElement,
	ai: AiClient,
	accessCache: AccessCache,
	aiResults: AiResultStore,
	debugLog: DebugLog,
): BadgeRenderer {
	const root = createRoot(container);
	return {
		render: ({ report, listing }, locale) =>
			root.render(
				createElement(RiskBadge, {
					report,
					listing,
					locale,
					ai,
					accessCache,
					aiResults,
					debugLog,
				}),
			),
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

/**
 * CSS de l'entrée, à l'URL que WXT charge lui-même en mode `"ui"`
 * (`loadCss` de `createShadowRootUi`) : le fichier reste déclaré dans
 * `web_accessible_resources` parce que l'entrée garde `cssInjectionMode: "ui"`.
 */
async function loadEntryCss(): Promise<string> {
	// Fichier produit au build, absent des chemins publics typés par WXT.
	const path = `/content-scripts/${import.meta.env.ENTRYPOINT}.css`;
	const url = browser.runtime.getURL(path as PublicPath);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

async function getLocale(site: Site): Promise<Locale> {
	return resolveContentLocale(
		site,
		await localePref.getValue(),
		navigator.language,
	);
}

export default defineContentScript({
	matches: CONTENT_MATCHES,
	cssInjectionMode: "ui",
	runAt: "document_idle",
	main(ctx) {
		// Polices de la pastille, sans attendre : le montage ne dépend pas d'elles.
		void loadFonts(document.fonts, (path) =>
			browser.runtime.getURL(path as PublicPath),
		);
		// Un seul client IA par content script, partagé par toutes les pastilles.
		const ai = createAiClient();
		// R8 : un accès en cache pour la pastille et les icônes de cartes.
		const accessCache = createAccessCache();
		// Résultats IA gardés 24 h (storage.local), partagés par la pastille et les cartes.
		const aiResults = createAiResultStore();
		// M1 : entrées expirées retirées une fois au démarrage ; aucune écriture sinon.
		void aiResults.prune();
		// Logs de debug de la page (superuser) : l'accès déjà en cache, ou le
		// drapeau du service worker (`content/debug`, sans appel réseau hors
		// session). Le drapeau passé à vrai demande un passage du contrôleur de
		// fiche, qui journalise alors l'annonce affichée (une fois par clé).
		// R5 : en build de production, drapeau inerte et aucun `content/debug`.
		const debugFlag = import.meta.env.DEV
			? createDebugFlag(
					() => sendToBackground<boolean>({ type: "content/debug" }),
					() => void controller.refresh(),
				)
			: disabledDebugFlag;
		const debugLog = createDebugLog(
			() => isDebugCached(accessCache) || debugFlag.current(),
		);
		// Les UI ne s'abonnent pas à l'invalidation (une fuite par montage) : les
		// `dispose()` ci-dessous les retirent toutes. R7 : pastille et icônes
		// partagent un CSS chargé une seule fois, sans `<style>` dans la page.
		const createUi = createUiFactory(ctx, loadEntryCss);
		const controller = createController({
			doc: document,
			getUrl: () => new URL(location.href),
			mounter: createBadgeMounter({
				createUi,
				createRenderer: (container) =>
					createReactRenderer(container, ai, accessCache, aiResults, debugLog),
			}),
			getLocale,
			debugLog,
		});
		// Icônes des cartes de résultats, à côté de la pastille de fiche.
		const cards = createCardController({
			doc: document,
			getUrl: () => new URL(location.href),
			ai,
			accessCache,
			aiResults,
			mountCard: createCardMounter({
				createUi,
				createRenderer: createCardRenderer,
			}),
			getLocale,
			win: window,
			debugLog,
		});
		ctx.addEventListener(window, "wxt:locationchange", () => {
			debugFlag.read();
			void controller.refresh();
			void cards.refresh();
		});
		// Retour sur l'onglet (connexion faite dans la popup) : drapeau relu s'il est faux.
		ctx.addEventListener(window, "focus", () => debugFlag.readIfOff());
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
		debugFlag.read();
	},
});
