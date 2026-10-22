/**
 * Doublure de `wxt/browser` pour la galerie : la langue de l'interface vient du
 * scénario de l'adresse. Seul ce dont les pages de la galerie se servent existe ;
 * le reste (ports, messages) n'est jamais appelé, les clients étant doublés.
 */
import { SCENARIO } from "./scenario";

export const browser = {
	i18n: { getUILanguage: () => SCENARIO.lang },
	runtime: {
		connect: () => {
			throw new Error("galerie : aucun service worker");
		},
		getURL: (path: string) => path,
	},
};

export type Browser = typeof browser;
