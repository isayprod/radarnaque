import type { Locale } from "@radarnaque/shared";
import type { ShadowRootContentScriptUiOptions } from "wxt/utils/content-script-ui/shadow-root";
import type { RiskReport } from "../rules/score";
import { BADGE_HOST_TAG, type Mounter } from "./controller";

/** Rendu de la pastille dans le conteneur du shadow root (React en production). */
export interface BadgeRenderer {
	render(report: RiskReport, locale: Locale): void;
	unmount(): void;
}

/** Sous-ensemble utilisé de `ShadowRootContentScriptUi`. */
export interface BadgeUi {
	shadowHost: HTMLElement;
	mount(): void;
	remove(): void;
}

export interface BadgeMounterDeps {
	/** `createShadowRootUi(ctx, options)` en production. */
	createUi(
		options: ShadowRootContentScriptUiOptions<BadgeRenderer>,
	): Promise<BadgeUi>;
	createRenderer(container: HTMLElement): BadgeRenderer;
	log?: (msg: string) => void;
}

/**
 * Pastille dans un shadow root, insérée après l'ancre. La création de l'UI est
 * asynchrone (chargement du CSS de l'extension) : un `unmount` ou un nouveau
 * `mount` arrivé entre-temps annule le montage en attente, et un `update`
 * arrivé entre-temps (rapport et locale) est rendu au montage.
 */
export function createBadgeMounter(deps: BadgeMounterDeps): Mounter {
	const log = deps.log ?? ((msg: string) => console.debug(msg));
	let ui: BadgeUi | null = null;
	let renderer: BadgeRenderer | null = null;
	let report: RiskReport | null = null;
	let locale: Locale = "fr";
	let pending = false;
	let generation = 0;
	/** Un échec n'est journalisé qu'une fois, jusqu'au prochain montage réussi. */
	let failureLogged = false;

	return {
		mount(anchor, nextReport, nextLocale) {
			const current = ++generation;
			report = nextReport;
			locale = nextLocale;
			pending = true;
			deps
				.createUi({
					name: BADGE_HOST_TAG,
					position: "inline",
					anchor,
					append: "after",
					onMount(container) {
						const created = deps.createRenderer(container);
						if (report) created.render(report, locale);
						renderer = created;
						return created;
					},
					onRemove(mounted) {
						mounted?.unmount();
					},
				})
				.then((created) => {
					if (current !== generation) return;
					created.mount();
					ui = created;
					pending = false;
					failureLogged = false;
				})
				.catch((error: unknown) => {
					if (current !== generation) return;
					pending = false;
					if (failureLogged) return;
					failureLogged = true;
					log(`radarnaque: affichage impossible (${String(error)})`);
				});
		},
		update(nextReport, nextLocale) {
			report = nextReport;
			locale = nextLocale;
			renderer?.render(nextReport, nextLocale);
		},
		unmount() {
			generation++;
			pending = false;
			ui?.remove();
			ui = null;
			renderer = null;
			report = null;
		},
		isMounted() {
			return pending || (ui?.shadowHost.isConnected ?? false);
		},
	};
}
