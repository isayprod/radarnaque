/**
 * Doublure de `lib/storage` pour la galerie de la popup : trois valeurs en mémoire,
 * avec l'interface des `storage.defineItem` de WXT dont la popup se sert
 * (`getValue`, `setValue`, `watch`). Langue et connexion en cours viennent du
 * scénario de l'adresse.
 */
import type { Locale } from "@radarnaque/shared";
import type { PendingSignIn } from "../../lib/storage";
import { DEMO_EMAIL, SCENARIO } from "./scenario";

export type { PendingSignIn } from "../../lib/storage";

type Watcher<T> = (value: T) => void;

function item<T>(initial: T) {
	let value = initial;
	const watchers = new Set<Watcher<T>>();
	return {
		getValue: async () => value,
		setValue: async (next: T) => {
			value = next;
			for (const watcher of watchers) watcher(next);
		},
		watch: (watcher: Watcher<T>) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
	};
}

export const sessionToken = item<string | null>(null);

export const localePref = item<Locale | null>(SCENARIO.lang);

export const pendingSignIn = item<PendingSignIn | null>(
	SCENARIO.state === "codeSent"
		? { email: DEMO_EMAIL, sentAt: Date.now() }
		: null,
);
