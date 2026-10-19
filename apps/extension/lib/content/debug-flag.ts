import type { BgResponse } from "../messages";

/**
 * Drapeau des logs de debug de la page, demandé au service worker
 * (`content/debug`) : il ne lit `me` que si une session existe. Il complète
 * l'accès en cache, qui n'est lu qu'à l'ouverture du panneau ou par les icônes.
 */
export interface DebugFlag {
	/** Dernier drapeau reçu ; faux tant que rien n'est lu, ou après une erreur. */
	current(): boolean;
	/** Relit le drapeau ; `onRise` est appelé s'il passe de faux à vrai. */
	read(): void;
	/** Relit seulement si le drapeau est faux (retour sur l'onglet). */
	readIfOff(): void;
}

export function createDebugFlag(
	fetchFlag: () => Promise<BgResponse<boolean>>,
	onRise: () => void,
): DebugFlag {
	let value = false;
	/** Numéro de la dernière lecture : seules ses réponses comptent. */
	let seq = 0;

	const settle = (n: number, next: boolean) => {
		if (n !== seq) return;
		const rose = next && !value;
		value = next;
		if (rose) onRise();
	};

	function read() {
		const n = ++seq;
		fetchFlag().then(
			(response) => settle(n, response.ok && response.data === true),
			() => settle(n, false),
		);
	}

	return {
		current: () => value,
		read,
		readIfOff() {
			if (!value) read();
		},
	};
}

/**
 * Drapeau inerte des builds de production (R5) : toujours faux, aucun message
 * `content/debug` envoyé. La plomberie du superuser n'existe qu'en dev.
 */
export const disabledDebugFlag: DebugFlag = {
	current: () => false,
	read() {},
	readIfOff() {},
};
