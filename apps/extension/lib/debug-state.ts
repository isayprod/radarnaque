import type { Me } from "@radarnaque/shared";
import { accessOf, isDebug } from "./access";
import { AuthError } from "./auth-client";
import { createDebugLog, type DebugSink } from "./debug-log";

/** Ce dont le service worker a besoin du stockage (`sessionToken` de `storage.ts`). */
export interface SessionTokenStore {
	getValue(): Promise<string | null>;
	setValue(value: string | null): Promise<void>;
}

export interface DebugStateDeps {
	sessionToken: SessionTokenStore;
	getMe(): Promise<Me>;
	/**
	 * Sortie des logs de debug du superuser (`console` par défaut ; un faux dans les
	 * tests). Rien n'y est écrit si le dernier `me` lu n'est pas superuser.
	 */
	debugLog?: DebugSink;
	/**
	 * Build de dev (`import.meta.env.DEV`). R5 : faux en production, `ensureKnown` ne lit
	 * jamais `me` (aucun échange de JWT ni `/api/me` de plus par réveil du service worker).
	 */
	devBuild: boolean;
}

/** Ce que le relais d'un scan utilise du debug du superuser. */
export interface ScanDebugHooks {
	/** Lecture paresseuse de `me` pour le debug, en dev seulement ; ne lève jamais. */
	ensureKnown(): Promise<void>;
	/** Écrit un groupe seulement si le jeton courant est celui du superuser vu. */
	group(title: string, data: unknown): Promise<void>;
}

export interface DebugState extends ScanDebugHooks {
	/**
	 * `Me` de l'utilisateur connecté, ou `null` sans session (aucun appel réseau) ou si
	 * elle a expiré ; retenu pour le debug si la session n'a pas changé pendant la lecture.
	 * Toute autre erreur (réseau, 503 `auth_unavailable`) est propagée.
	 */
	trackedMe(): Promise<Me | null>;
	/** Vrai si le dernier `me` retenu, lu avec ce jeton, est celui du superuser. */
	isOnFor(token: string | null): boolean;
}

/**
 * Debug du superuser, partagé par les messages (`createHandlers`) et le port
 * `scan/stream` : créé une fois par service worker.
 */
export function createDebugState(deps: DebugStateDeps): DebugState {
	const { sessionToken } = deps;

	/**
	 * Debug du dernier `me` lu, lié au jeton de session utilisé pour le lire (R3). Un
	 * changement de jeton, quelle qu'en soit la cause (OTP, lien magique, déconnexion,
	 * `onUnauthenticated`), coupe les logs sans remise à zéro explicite.
	 */
	let debugFor: { token: string; debug: boolean } | null = null;
	/** Jeton lu juste avant chaque groupe de log : `enabled()` est synchrone. */
	let tokenForLog: string | null = null;
	// Seuls le corps `ScanIn`, les événements, le résultat et le code d'erreur y passent :
	// jamais d'en-tête, de JWT, de jeton de session ni de cookie.
	const debugLog = createDebugLog(
		() =>
			debugFor?.debug === true &&
			tokenForLog !== null &&
			debugFor.token === tokenForLog,
		deps.debugLog,
	);

	async function currentMe(): Promise<Me | null> {
		if (!(await sessionToken.getValue())) return null;
		try {
			return await deps.getMe();
		} catch (error) {
			// L'api client a déjà effacé la session (onUnauthenticated).
			if (error instanceof AuthError && error.code === "session_expired") {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Le jeton est lu avant l'appel ; si la session a changé pendant l'appel
	 * (déconnexion, nouveau jeton), le résultat n'est pas retenu pour le debug.
	 */
	async function trackedMe(): Promise<Me | null> {
		const token = await sessionToken.getValue();
		const me = await currentMe();
		const after = await sessionToken.getValue();
		if (token && after === token) {
			debugFor = me ? { token, debug: isDebug(accessOf(me)) } : null;
		}
		return me;
	}

	return {
		trackedMe,
		isOnFor: (token) =>
			token !== null && debugFor?.token === token && debugFor.debug === true,
		/**
		 * Après un réveil du service worker (ou un changement de session), `debugFor` ne
		 * correspond pas au jeton courant : une seule lecture de `me`, et seulement quand
		 * un scan ou le drapeau de debug est demandé. Un échec laisse les logs coupés.
		 */
		async ensureKnown() {
			// R5 : build de production, aucune lecture (ni stockage ni réseau).
			if (!deps.devBuild) return;
			try {
				const token = await sessionToken.getValue();
				if (!token || debugFor?.token === token) return;
				await trackedMe();
			} catch {
				// Logs coupés ; le scan continue normalement.
			}
		},
		async group(title, data) {
			// Compte ordinaire : pas même une lecture du stockage.
			if (!debugFor?.debug) return;
			try {
				tokenForLog = await sessionToken.getValue();
			} catch {
				tokenForLog = null;
			}
			debugLog.group(title, data);
		},
	};
}
