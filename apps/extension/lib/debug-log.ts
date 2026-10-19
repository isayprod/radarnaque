/** Partie de `console` utilisée par les logs de debug ; injectable pour les tests. */
export type DebugSink = Pick<Console, "groupCollapsed" | "log" | "groupEnd">;

export interface DebugLog {
	/** Écrit un groupe replié `[Radarnaque debug] <title>` contenant `data` en objet. */
	group(title: string, data: unknown): void;
	/**
	 * Vrai si un groupe écrit maintenant le serait : l'appelant qui déduplique ses
	 * logs ne marque une entrée comme journalisée que dans ce cas. Ne lève jamais.
	 */
	enabled(): boolean;
}

/**
 * Logs de debug du superuser de développement. `enabled` est relu à chaque appel :
 * rien n'est écrit tant qu'il est faux. Ne lève jamais (console absente ou cassée).
 * L'appelant ne passe jamais d'en-tête, de JWT ni de jeton de session dans `data`.
 */
export function createDebugLog(
	enabled: () => boolean,
	sink: DebugSink = console,
): DebugLog {
	return {
		enabled() {
			try {
				return enabled();
			} catch {
				return false;
			}
		},
		group(title, data) {
			try {
				if (!enabled()) return;
				sink.groupCollapsed(`[Radarnaque debug] ${title}`);
				try {
					sink.log(data);
				} finally {
					sink.groupEnd();
				}
			} catch {
				// Un log de debug ne doit jamais casser un scan.
			}
		},
	};
}
