import type { AnalysisResult, IdentificationResult } from "@radarnaque/shared";
import { storage } from "wxt/utils/storage";
import type { Listing, Site } from "../listing/types";
import { toIdentificationResult } from "../scan-events";

/**
 * Un résultat IA reste valable 24 h après l'analyse (`analyzedAt`), 24 h après
 * l'identification (`identifiedAt`) et 24 h après son écriture (`storedAt`) :
 * la première échéance atteinte l'emporte.
 */
export const AI_RESULT_TTL_MS = 24 * 60 * 60_000;

/** Au plus 200 annonces gardées : les plus anciennes (`storedAt`) sont retirées. */
export const MAX_AI_RESULTS = 200;

/**
 * Résultat IA gardé pour une annonce : une seule place par annonce, avec
 * l'analyse, l'identification ou les deux (au moins l'une est non nulle).
 */
export interface StoredAiResult {
	result: AnalysisResult | null;
	identification: IdentificationResult | null;
	/** Vrai seulement si l'identification vient d'un « Identifier » de cet utilisateur. */
	identifiedByUser: boolean;
	/** `listingFingerprint` de l'annonce analysée. */
	fingerprint: string;
	/** Heure d'écriture, en millisecondes epoch. */
	storedAt: number;
}

/**
 * Empreinte de ce que l'IA a lu et qui peut changer sur une même annonce :
 * titre, description, prix, type de prix et caractéristiques (kilométrage…).
 * Une annonce modifiée n'a plus la même empreinte, et son ancien verdict n'est
 * pas réutilisé par la pastille.
 */
export function listingFingerprint(l: Listing): string {
	return JSON.stringify({
		title: l.title,
		description: l.description,
		price: l.price
			? { amountCents: l.price.amountCents, currency: l.price.currency }
			: null,
		priceType: l.priceType,
		attributes: l.attributes ?? [],
	});
}

/**
 * Valeur stockée sous `site|externalId`. Une entrée `v: 2` (analyse seule) est
 * relue avec l'identification qu'elle embarque ; sans `v: 2` ni `v: 3`, elle est
 * ignorée, puis remplacée : l'ancienne forme `{ v: 1, text, image }` n'est plus
 * lue.
 */
export interface StoredAiEntry extends StoredAiResult {
	v: 3;
}

/**
 * Quota restant inconnu. Celui d'un résultat gardé date de l'analyse, jusqu'à
 * 24 h plus tôt : il n'est ni stocké ni affiché (I1).
 */
export const NO_REMAINING: AnalysisResult["remaining"] = Object.freeze({
	scans: null,
});

/** Le résultat (analyse ou identification) sans son quota restant d'alors. */
export const withoutRemaining = <T extends { remaining?: unknown }>(
	result: T,
): T => ({
	...result,
	remaining: { ...NO_REMAINING },
});

/**
 * Le résultat tel qu'il est gardé : sans quota restant (I1) ni bloc `debug` du
 * superuser, dont les prompts et la réponse brute ne vont jamais dans
 * `storage.local`. Un résultat repris n'a donc pas de section Debug.
 */
export const toStored = ({
	debug: _,
	...result
}: AnalysisResult): AnalysisResult => withoutRemaining(result);

/** L'identification telle qu'elle est gardée : sans quota restant ni `debug`. */
export const toStoredIdentification = ({
	debug: _,
	...identification
}: IdentificationResult): IdentificationResult =>
	withoutRemaining(identification);

/** Stockage d'une valeur : `storage.defineItem` de WXT, ou un double en test. */
export interface StorageAreaLike {
	getValue(): Promise<Record<string, StoredAiEntry>>;
	setValue(value: Record<string, StoredAiEntry>): Promise<void>;
}

/**
 * Résultats IA par annonce, partagés par la pastille de fiche et les icônes de
 * cartes. Ne lève jamais : un stockage indisponible ou plein se comporte comme
 * un stockage vide.
 */
export interface AiResultStore {
	/**
	 * Le résultat valable de l'annonce, sans quota restant ni debug ; null si aucun
	 * (absent, expiré, illisible ou d'une ancienne forme).
	 */
	get(site: Site, externalId: string): Promise<StoredAiResult | null>;
	/**
	 * Écrit la place de l'annonce. Au plus 200 annonces : les plus anciennes sont
	 * retirées.
	 */
	put(site: Site, externalId: string, entry: StoredAiResult): Promise<void>;
	/** Retire les entrées expirées ; n'écrit que s'il y en a. */
	prune(): Promise<void>;
}

const keyOf = (site: Site, externalId: string) => `${site}|${externalId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** L'analyse d'une valeur lue : son objet, ou null si elle n'en a pas la forme. */
const toAnalysis = (value: unknown): AnalysisResult | null =>
	isRecord(value) && typeof value.partial === "boolean"
		? (value as unknown as AnalysisResult)
		: null;

/**
 * Entrée lue sous sa forme `v: 3`, champs connus seuls ; l'ancienne `v: 2` est
 * relue comme une analyse avec son identification embarquée. Null si illisible
 * ou si ni l'analyse ni l'identification n'est lisible.
 */
function parseEntry(value: unknown): StoredAiEntry | null {
	if (
		!isRecord(value) ||
		typeof value.fingerprint !== "string" ||
		typeof value.storedAt !== "number"
	)
		return null;
	const { fingerprint, storedAt } = value;
	if (value.v === 2) {
		const result = toAnalysis(value.result);
		if (!result) return null;
		const identification = toIdentificationResult(result.identification);
		return {
			v: 3,
			result,
			identification,
			identifiedByUser: false,
			fingerprint,
			storedAt,
		};
	}
	if (value.v !== 3 || typeof value.identifiedByUser !== "boolean") return null;
	const result = value.result === null ? null : toAnalysis(value.result);
	const identification =
		value.identification === null
			? null
			: toIdentificationResult(value.identification);
	if (
		(value.result !== null && !result) ||
		(value.identification !== null && !identification) ||
		(!result && !identification)
	)
		return null;
	return {
		v: 3,
		result,
		identification,
		identifiedByUser: identification !== null && value.identifiedByUser,
		fingerprint,
		storedAt,
	};
}

/**
 * M4 : expiré 24 h après la plus ancienne des dates d'analyse et
 * d'identification présentes, ou 24 h après l'écriture.
 */
function isExpired(entry: StoredAiResult, now: number): boolean {
	const dates = [
		entry.result?.analyzedAt,
		entry.identification?.identifiedAt,
	].map((date) => (date === undefined ? Number.NaN : Date.parse(date)));
	for (const date of dates)
		if (!Number.isNaN(date) && now - date > AI_RESULT_TTL_MS) return true;
	return now - entry.storedAt > AI_RESULT_TTL_MS;
}

/** Entrée valable d'une valeur lue, champs connus seuls ; null sinon. */
function cleanEntry(value: unknown, now: number): StoredAiEntry | null {
	const entry = parseEntry(value);
	return entry && !isExpired(entry, now) ? entry : null;
}

/**
 * Valeur lue débarrassée des entrées expirées ou illisibles, puis bornée aux
 * 200 annonces les plus récentes. `dropped` : quelque chose a été retiré.
 */
function cleanMap(
	raw: Record<string, unknown>,
	now: number,
): { map: Record<string, StoredAiEntry>; dropped: boolean } {
	let dropped = false;
	const kept: Array<[string, StoredAiEntry]> = [];
	for (const [key, value] of Object.entries(raw)) {
		const entry = cleanEntry(value, now);
		if (!entry) {
			dropped = true;
			continue;
		}
		kept.push([key, entry]);
	}
	kept.sort((a, b) => b[1].storedAt - a[1].storedAt);
	if (kept.length > MAX_AI_RESULTS) dropped = true;
	return {
		map: Object.fromEntries(kept.slice(0, MAX_AI_RESULTS)),
		dropped,
	};
}

/** Clé de stockage des résultats IA (`storage.local`). */
export const AI_RESULTS_KEY = "local:aiResults";

/** `storage.local`, sous la clé `aiResults`. */
const defaultArea = (): StorageAreaLike =>
	storage.defineItem<Record<string, StoredAiEntry>>(AI_RESULTS_KEY, {
		fallback: {},
	});

/**
 * R5 : vide les résultats gardés, à la déconnexion (service worker). Les
 * content scripts déjà ouverts gardent leur copie en mémoire (M2) jusqu'au
 * prochain chargement de page : accepté.
 */
export const clearAiResults = (): Promise<void> =>
	storage.removeItem(AI_RESULTS_KEY);

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

	/**
	 * M2 : copie en mémoire de la valeur stockée, pour ce content script. Les
	 * icônes montées ensemble ne lisent le stockage qu'une fois ; `put` relit le
	 * stockage (écritures des autres onglets) puis met la copie à jour.
	 */
	let memory: Record<string, unknown> | null = null;

	const readFresh = async (): Promise<Record<string, unknown>> => {
		const value = await area.getValue();
		return isRecord(value) ? value : {};
	};

	/** Écrit `map` ; la copie n'est mise à jour qu'après une écriture réussie. */
	const write = async (map: Record<string, StoredAiEntry>) => {
		memory = null;
		await area.setValue(map);
		memory = map;
	};

	return {
		get: (site, externalId) =>
			serial(async () => {
				memory ??= await readFresh();
				const entry = cleanEntry(memory[keyOf(site, externalId)], now());
				if (!entry) return null;
				const { result, identification, identifiedByUser } = entry;
				return {
					result: result && toStored(result),
					identification:
						identification && toStoredIdentification(identification),
					identifiedByUser,
					fingerprint: entry.fingerprint,
					storedAt: entry.storedAt,
				};
			}, null),

		put: (site, externalId, entry) =>
			serial(async () => {
				const { map } = cleanMap(await readFresh(), now());
				const key = keyOf(site, externalId);
				const previous = map[key];
				// Même empreinte : l'analyse et l'identification déjà gardées sont
				// conservées ; une autre empreinte remplace toute l'entrée.
				const same =
					previous?.fingerprint === entry.fingerprint ? previous : null;
				// Une identification donnée l'emporte ; sinon celle qu'embarque l'analyse
				// écrite, puis celle déjà gardée (même empreinte).
				const embedded = toIdentificationResult(entry.result?.identification);
				const given = entry.identification ?? embedded;
				// Un résultat partiel (carte Facebook) ne remplace jamais l'analyse
				// complète encore valable : sans identification à ajouter, rien n'est écrit.
				const protectsFull =
					entry.result?.partial && previous?.result && !previous.result.partial;
				if (protectsFull && (!same || !given)) {
					memory = map;
					return;
				}
				const result = protectsFull
					? previous?.result
					: (entry.result ?? same?.result ?? null);
				const identification = given ?? same?.identification ?? null;
				const identifiedByUser = entry.identification
					? entry.identifiedByUser
					: embedded
						? false
						: (same?.identifiedByUser ?? false);
				if (!result && !identification) {
					memory = map;
					return;
				}
				const next: Record<string, StoredAiEntry> = {
					[key]: {
						v: 3,
						result: result && toStored(result),
						identification:
							identification && toStoredIdentification(identification),
						identifiedByUser: identification !== null && identifiedByUser,
						fingerprint: entry.fingerprint,
						storedAt: entry.storedAt,
					},
				};
				for (const [k, value] of Object.entries(map))
					if (k !== key) next[k] = value;
				await write(cleanMap(next, now()).map);
			}, undefined),

		prune: () =>
			serial(async () => {
				const { map, dropped } = cleanMap(await readFresh(), now());
				if (dropped) await write(map);
				else memory = map;
			}, undefined),
	};
}
