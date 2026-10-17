import type { ContentScriptContext } from "wxt/utils/content-script-context";
import {
	createShadowRootUi,
	type ShadowRootContentScriptUi,
	type ShadowRootContentScriptUiOptions,
} from "wxt/utils/content-script-ui/shadow-root";
import { splitShadowRootCss } from "wxt/utils/split-shadow-root-css";

/**
 * Contexte passé à `createShadowRootUi` : `onInvalidated` ne s'abonne à rien.
 * WXT y enregistre un `remove` par UI sans jamais le retirer : avec une UI par
 * carte, chaque montage garderait sa carte en mémoire jusqu'à l'invalidation.
 * Le nettoyage passe par les `dispose()` des contrôleurs, appelés dans
 * `ctx.onInvalidated`.
 *
 * R7 : `cssInjectionMode` vaut `"manual"` ici, quel que soit le mode de
 * l'entrée : WXT ne recharge plus le CSS à chaque UI, il le reçoit déjà chargé
 * dans `options.css` (voir `createUiFactory`).
 *
 * Le transtypage repose sur WXT 0.21.4 (version épinglée dans package.json) :
 * `createShadowRootUi` n'y lit de `ctx` que `ctx.options` et `ctx.onInvalidated`.
 * À revérifier dans `dist/utils/content-script-ui/shadow-root.mjs` à chaque
 * mise à jour de WXT.
 */
export function detachedUiContext(
	ctx: ContentScriptContext,
): ContentScriptContext {
	return {
		options: { ...ctx.options, cssInjectionMode: "manual" },
		onInvalidated: () => () => {},
	} as unknown as ContentScriptContext;
}

/**
 * CSS de l'entrée adapté au shadow root, comme WXT le fait en mode `"ui"` :
 * `:root` devient `:host`. Les blocs `@property` (et `@font-face`), que WXT
 * insérerait dans `document.head` à chaque UI, sont retirés : badge.css
 * redéfinit sur `:host` les variables `--tw-*` dont la valeur initiale compte.
 */
export function shadowCssOf(entryCss: string): string {
	return splitShadowRootCss(entryCss.replaceAll(":root", ":host")).shadowCss;
}

export type UiFactory = <T>(
	options: ShadowRootContentScriptUiOptions<T>,
) => Promise<ShadowRootContentScriptUi<T>>;

/**
 * `createShadowRootUi` avec un contexte détaché et un CSS partagé : `loadCss`
 * n'est appelé qu'une fois par content script (un échec est réessayé au
 * montage suivant, l'UI étant montée sans CSS en attendant, comme le fait WXT).
 */
export function createUiFactory(
	ctx: ContentScriptContext,
	loadCss: () => Promise<string>,
	log: (msg: string) => void = (msg) => console.debug(msg),
): UiFactory {
	const uiCtx = detachedUiContext(ctx);
	let shared: Promise<string> | null = null;
	const css = () => {
		shared ??= loadCss().then(shadowCssOf, (error: unknown) => {
			shared = null;
			log(`radarnaque: styles indisponibles (${String(error)})`);
			return "";
		});
		return shared;
	};
	return async (options) => {
		const loaded = await css();
		return createShadowRootUi(uiCtx, {
			...options,
			css: options.css ? `${loaded}\n${options.css}` : loaded,
		});
	};
}
