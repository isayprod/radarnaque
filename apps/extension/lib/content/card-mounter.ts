import type { ShadowRootContentScriptUiOptions } from "wxt/utils/content-script-ui/shadow-root";
import type { CardRef } from "../adapters/types";
import {
	CARD_HOST_TAG,
	type CardMount,
	type CardView,
} from "./card-controller";

/** Rendu de l'icône dans le conteneur du shadow root (React en production). */
export interface CardRenderer {
	render(view: CardView): void;
	unmount(): void;
}

/** Sous-ensemble utilisé de `ShadowRootContentScriptUi`. */
export interface CardUi {
	shadowHost: HTMLElement;
	mount(): void;
	remove(): void;
}

export interface CardMounterDeps {
	/** `createShadowRootUi(ctx, options)` en production. */
	createUi(
		options: ShadowRootContentScriptUiOptions<CardRenderer>,
	): Promise<CardUi>;
	createRenderer(container: HTMLElement): CardRenderer;
	log?: (msg: string) => void;
}

/**
 * Une UI par carte : un shadow root inséré après l'ancre, avec sa propre racine
 * React. La création est asynchrone (chargement du CSS) : un `unmount` arrivé
 * entre-temps l'annule, un `update` arrivé entre-temps est rendu au montage.
 */
export function createCardMounter(
	deps: CardMounterDeps,
): (anchor: Element, card: CardRef, view: CardView) => CardMount {
	const log = deps.log ?? ((msg: string) => console.debug(msg));
	/** Un échec n'est journalisé qu'une fois pour toutes les cartes. */
	let failureLogged = false;

	return (anchor, _card, initial) => {
		let view = initial;
		let ui: CardUi | null = null;
		let renderer: CardRenderer | null = null;
		let pending = true;
		let cancelled = false;

		deps
			.createUi({
				name: CARD_HOST_TAG,
				position: "inline",
				anchor,
				append: "after",
				onMount(container) {
					const created = deps.createRenderer(container);
					created.render(view);
					renderer = created;
					return created;
				},
				onRemove(mounted) {
					mounted?.unmount();
				},
			})
			.then((created) => {
				if (cancelled) return;
				created.mount();
				ui = created;
				pending = false;
			})
			.catch((error: unknown) => {
				pending = false;
				if (cancelled || failureLogged) return;
				failureLogged = true;
				log(`radarnaque: affichage impossible (${String(error)})`);
			});

		return {
			update(next) {
				view = next;
				renderer?.render(next);
			},
			unmount() {
				cancelled = true;
				pending = false;
				ui?.remove();
				ui = null;
				renderer = null;
			},
			isMounted() {
				return pending || (ui?.shadowHost.isConnected ?? false);
			},
		};
	};
}
