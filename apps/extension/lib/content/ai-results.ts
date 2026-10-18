import type { AnalysisResult } from "@radarnaque/shared";
import { storage } from "wxt/utils/storage";
import type { Listing, Site } from "../listing/types";
import type { ScanKind } from "../messages";

/** Un résultat IA reste valable 24 h après l'analyse (`analyzedAt`). */
export const AI_RESULT_TTL_MS = 24 * 60 * 60_000;

/** Au plus 200 annonces gardées : les plus anciennes (`storedAt`) sont retirées. */
export const MAX_AI_RESULTS = 200;

/** Résultat IA gardé dans le navigateur pour une annonce. */
export interface StoredAiResult {
	result: AnalysisResult;
	scanKind: ScanKind;
	/** `listingFingerprint` de l'annonce analysée. */
	fingerprint: string;
	/** Heure d'écriture, en millisecondes epoch. */
	storedAt: number;
}

/**
 * Empreinte de ce que l'IA a lu et qui peut changer sur une même annonce :
 * titre, description, prix et type de prix. Une annonce modifiée n'a plus la
 * même empreinte, et son ancien verdict n'est pas réutilisé par la pastille.
 */
export function listingFingerprint(l: Listing): string {
	return JSON.stringify({
		title: l.title,
		description: l.description,
		price: l.price
			? { amountCents: l.price.amountCents, currency: l.price.currency }
			: null,
		priceType: l.priceType,
	});
}

/** Stockage d'une valeur : `storage.defineItem` de WXT, ou un double en test. */
export interface StorageAreaLike {
	getValue(): Promise<Record<string, StoredAiResult>>;
	setValue(value: Record<string, StoredAiResult>): Promise<void>;
}

/**
 * Résultats IA par annonce, partagés par la pastille de fiche et les icônes de
 * cartes. Ne lève jamais : un stockage indisponible ou plein se comporte comme
 * un stockage vide.
 */
export interface AiResultStore {
	/** null si absent, expiré (> 24 h depuis analyzedAt) ou illisible. */
	get(site: Site, externalId: string): Promise<StoredAiResult | null>;
	/** Au plus 200 entrées : les plus anciennes sont retirées. */
	put(site: Site, externalId: string, entry: StoredAiResult): Promise<void>;
}

const keyOf = (site: Site, externalId: string) => `${site}|${externalId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Vérifie la forme d'une entrée lue : le stockage peut contenir n'importe quoi. */
function isStoredAiResult(value: unknown): value is StoredAiResult {
	if (!isRecord(value) || !isRecord(value.result)) return false;
	return (
		(value.scanKind === "text" || value.scanKind === "image") &&
		typeof value.fingerprint === "string" &&
		typeof value.storedAt === "number" &&
		typeof value.result.partial === "boolean"
	);
}

/** Départ des 24 h : `analyzedAt`, ou `storedAt` s'il est illisible. */
function startOf(entry: StoredAiResult): number {
	const analyzed = Date.parse(entry.result.analyzedAt);
	return Number.isNaN(analyzed) ? entry.storedAt : analyzed;
}

const isExpired = (entry: StoredAiResult, now: number) =>
	now - startOf(entry) > AI_RESULT_TTL_MS;

/** `storage.local`, sous la clé `aiResults`. */
const defaultArea = (): StorageAreaLike =>
	storage.defineItem<Record<string, StoredAiResult>>("local:aiResults", {
		fallback: {},
	});

export function createAiResultStore(
	area: StorageAreaLike = defaultArea(),
	now: () => number = () => Date.now(),
	log: (msg: string) => void = (msg) => console.debug(msg),
): AiResultStore {
	let logged = false;
	const fail = (error: unknown) => {
		if (logged) return;
		logged = true;
		log(
			`radarnaque: stockage des résultats IA indisponible (${String(error)})`,
		);
	};
	/**
	 * Lectures et écritures l'une après l'autre : deux `put` simultanés du même
	 * content script ne perdent aucune entrée. Entre onglets, la dernière
	 * écriture l'emporte.
	 */
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(task: () => Promise<T>, fallback: T): Promise<T> => {
		const run = chain.then(task).catch((error: unknown) => {
			fail(error);
			return fallback;
		});
		chain = run;
		return run;
	};

	const read = async (): Promise<Record<string, unknown>> => {
		const value = await area.getValue();
		return isRecord(value) ? value : {};
	};

	return {
		get: (site, externalId) =>
			serial(async () => {
				const entry = (await read())[keyOf(site, externalId)];
				if (!isStoredAiResult(entry) || isExpired(entry, now())) return null;
				return entry;
			}, null),

		put: (site, externalId, entry) =>
			serial(async () => {
				const at = now();
				const kept: Array<[string, StoredAiResult]> = [];
				for (const [key, value] of Object.entries(await read()))
					if (isStoredAiResult(value) && !isExpired(value, at))
						kept.push([key, value]);
				const key = keyOf(site, externalId);
				const previous = kept.find(([k]) => k === key)?.[1];
				// Un résultat partiel (carte Facebook) ne remplace jamais l'analyse
				// de la fiche complète encore valable.
				if (entry.result.partial && previous && !previous.result.partial)
					return;
				const next = kept.filter(([k]) => k !== key);
				next.push([key, entry]);
				next.sort((a, b) => b[1].storedAt - a[1].storedAt);
				await area.setValue(Object.fromEntries(next.slice(0, MAX_AI_RESULTS)));
			}, undefined),
	};
}
