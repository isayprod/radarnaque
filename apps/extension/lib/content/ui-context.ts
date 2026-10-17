import type { ContentScriptContext } from "wxt/utils/content-script-context";

/**
 * Contexte passé à `createShadowRootUi` : mêmes options que `ctx` (CSS injecté
 * dans l'UI), mais `onInvalidated` ne s'abonne à rien. WXT y enregistre un
 * `remove` par UI sans jamais le retirer : avec une UI par carte, chaque
 * montage garderait sa carte en mémoire jusqu'à l'invalidation. Le nettoyage
 * passe par les `dispose()` des contrôleurs, appelés dans `ctx.onInvalidated`.
 */
export function detachedUiContext(
	ctx: ContentScriptContext,
): ContentScriptContext {
	return {
		options: ctx.options,
		onInvalidated: () => () => {},
	} as unknown as ContentScriptContext;
}
