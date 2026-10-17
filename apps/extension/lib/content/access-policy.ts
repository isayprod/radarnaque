import type { ContentAccess } from "../messages";

/** Accès lu : la réponse du service worker, ou le code de l'erreur. */
export type AccessReading = ContentAccess | { error: string };

/** Erreurs de session : reconnexion demandée, l'accès en cache ne vaut plus. */
export const RELOGIN_CODES: ReadonlySet<string> = new Set([
	"session_expired",
	"unauthenticated",
]);

/** `noSubscription` ou erreur : au plus une relecture toutes les 30 s (appel à l'API). */
export const RECHECK_MS = 30_000;

/** `active` : gardé 5 min, y compris d'une URL à l'autre. */
export const ACTIVE_TTL_MS = 5 * 60_000;

export const isContentAccess = (
	reading: AccessReading | null,
): reading is ContentAccess => reading !== null && "status" in reading;

/**
 * R8 : vrai si l'accès `reading`, lu à `at`, doit être relu à `now`.
 * `signedOut` est relu sans délai : le service worker répond sans appel réseau.
 */
export function isStale(
	reading: AccessReading,
	at: number,
	now: number,
): boolean {
	if (!isContentAccess(reading)) return now - at >= RECHECK_MS;
	if (reading.status === "signedOut") return true;
	const ttl = reading.status === "active" ? ACTIVE_TTL_MS : RECHECK_MS;
	return now - at >= ttl;
}

/** Lecture commencée : son numéro et son heure de début. */
export interface AccessTicket {
	readonly seq: number;
	readonly at: number;
}

/**
 * Dernier accès lu, partagé par la pastille de fiche et les icônes de cartes
 * (un par content script). Chacun décide d'une lecture par `needsRead()` au
 * moment où il en a l'occasion (ouverture du panneau, focus, nouvelle URL).
 */
export interface AccessCache {
	/** Dernier accès lu, ou null (jamais lu, ou invalidé). */
	current(): AccessReading | null;
	/** Vrai si aucun accès n'est en cache ou si la politique R8 le dit périmé. */
	needsRead(): boolean;
	/** À appeler au début d'une lecture ; son ticket est passé à `settle`. */
	begin(): AccessTicket;
	/**
	 * Enregistre le résultat d'une lecture, sauf si une lecture plus récente a
	 * déjà répondu ou si le cache a été invalidé depuis son début.
	 */
	settle(ticket: AccessTicket, reading: AccessReading): void;
	/** Session expirée : l'accès en cache est oublié, la prochaine lecture est immédiate. */
	invalidate(): void;
}

export function createAccessCache(
	now: () => number = () => Date.now(),
): AccessCache {
	let entry: { reading: AccessReading; at: number; seq: number } | null = null;
	let nextSeq = 0;
	/** Les tickets plus anciens que ce numéro datent d'avant une invalidation. */
	let floor = 0;
	return {
		current: () => entry?.reading ?? null,
		needsRead: () => entry === null || isStale(entry.reading, entry.at, now()),
		begin: () => ({ seq: nextSeq++, at: now() }),
		settle(ticket, reading) {
			if (ticket.seq < floor || (entry && ticket.seq < entry.seq)) return;
			entry = { reading, at: ticket.at, seq: ticket.seq };
		},
		invalidate() {
			entry = null;
			floor = nextSeq;
		},
	};
}
