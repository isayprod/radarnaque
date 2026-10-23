import type {
	AnalysisResult,
	IdentificationResult,
	ScanProgressEvent,
	SearchAspect,
} from "@radarnaque/shared";
import { cut } from "./scan-payload";
import type { SseMessage } from "./sse";

/** Fin du flux telle que le port la poste à l'onglet. */
export type StreamOutcome =
	| { type: "result"; result: AnalysisResult | IdentificationResult }
	| { type: "error"; code: string };

/** Bornes des chaînes relayées à la page (spec §10.1). */
export const EVENT_BOUNDS = {
	text: 600,
	query: 200,
	domains: 3,
	domain: 100,
} as const;

const STAGES: ReadonlySet<string> = new Set([
	"cache",
	"photos",
	"analyzing",
	"reading_photos",
	"criteria",
	"identifying",
	"retrying",
	"writing",
]);
const ASPECTS: ReadonlySet<string> = new Set<SearchAspect>([
	"model",
	"price",
	"scam",
	"other",
]);
const LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
const IDENTIFICATION_STATUSES: ReadonlySet<string> = new Set([
	"identified",
	"uncertain",
	"none",
]);
const IDENTIFICATION_LEVELS: ReadonlySet<string> = new Set([
	"sure",
	"probable",
	"uncertain",
]);
/** Objets d'une identification au plus (spec identification §6). */
const MAX_OBJECTS = 4;
const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "danger"]);
/** Code d'erreur de l'API : jamais de texte libre relayé à la page. */
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
	Number.isInteger(value) && (value as number) >= 0;

const isLocalized = (value: unknown): boolean =>
	isRecord(value) &&
	typeof value.fr === "string" &&
	typeof value.nl === "string";

const isReason = (value: unknown): boolean =>
	isRecord(value) &&
	typeof value.severity === "string" &&
	SEVERITIES.has(value.severity) &&
	isLocalized(value.text);

const isWebSearch = (value: unknown): boolean =>
	isRecord(value) &&
	typeof value.query === "string" &&
	typeof value.aspect === "string" &&
	ASPECTS.has(value.aspect);

/**
 * Forme d'un `AnalysisResultOut` reçu de l'API, vérifiée avant d'être relayée à la page.
 * Le bloc `debug` du superuser n'est vérifié qu'en surface (un objet, ou absent).
 */
export function isAnalysisResult(value: unknown): value is AnalysisResult {
	if (!isRecord(value)) return false;
	const { remaining, debug } = value;
	return (
		Number.isInteger(value.analysisId) &&
		typeof value.analyzedAt === "string" &&
		typeof value.fromCache === "boolean" &&
		typeof value.partial === "boolean" &&
		typeof value.professional === "boolean" &&
		typeof value.level === "string" &&
		LEVELS.has(value.level) &&
		typeof value.score === "number" &&
		value.score >= 0 &&
		value.score <= 100 &&
		isLocalized(value.summary) &&
		isLocalized(value.advice) &&
		Array.isArray(value.reasons) &&
		value.reasons.every(isReason) &&
		isRecord(remaining) &&
		(remaining.scans === null || isCount(remaining.scans)) &&
		isCount(value.imagesAnalyzed) &&
		Array.isArray(value.webSearches) &&
		value.webSearches.every(isWebSearch) &&
		(debug === undefined || debug === null || isRecord(debug))
	);
}

/** Bornes des chaînes et des tableaux d'une identification, relayés à la page. */
const IDENTIFICATION_BOUNDS = {
	label: 120,
	sentence: 300,
	title: 200,
	domain: 100,
	url: 300,
	date: 64,
	objects: MAX_OBJECTS,
	checks: 8,
	pages: 3,
	sources: 5,
	remaining: 3,
	photoObservations: 6,
	searches: 10,
	pagesRead: 10,
} as const;
const OBSERVATIONS: ReadonlySet<string> = new Set([
	"seen_match",
	"seen_contrary",
	"not_visible",
]);
const PHOTO_KINDS: ReadonlySet<string> = new Set([
	"catalog",
	"screenshot",
	"watermark",
	"inconsistency",
	"missing_object",
]);
const SEARCH_KINDS: ReadonlySet<string> = new Set([
	"criteria",
	"price",
	"reference",
	"retry",
]);
const ROLES: ReadonlySet<string> = new Set(["main", "accessory"]);

type Check = IdentificationResult["objects"][number]["checks"][number];
type PageLink = Check["sources"][number];
type Localized = { fr: string; nl: string };

const isPercent = (value: unknown): value is number =>
	Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;

/** Entier à partir de 1 (numéro de photo), ou `null`. */
const isPhoto = (value: unknown): value is number | null =>
	value === null || (Number.isInteger(value) && (value as number) >= 1);

const localized = (value: unknown): Localized | null =>
	isLocalized(value)
		? {
				fr: cut((value as Localized).fr, IDENTIFICATION_BOUNDS.sentence),
				nl: cut((value as Localized).nl, IDENTIFICATION_BOUNDS.sentence),
			}
		: null;

/** Liens `https://` seulement, au plus `max` : les autres sont écartés, jamais corrigés. */
function pageLinks(value: unknown, max: number): PageLink[] | null {
	if (!Array.isArray(value)) return null;
	const out: PageLink[] = [];
	for (const page of value) {
		if (!isRecord(page)) return null;
		const { url, title, domain } = page;
		if (
			typeof url !== "string" ||
			typeof title !== "string" ||
			typeof domain !== "string"
		) {
			return null;
		}
		if (!url.startsWith("https://") || out.length >= max) continue;
		out.push({
			url: cut(url, IDENTIFICATION_BOUNDS.url),
			title: cut(title, IDENTIFICATION_BOUNDS.title),
			domain: cut(domain, IDENTIFICATION_BOUNDS.domain),
		});
	}
	return out;
}

function toCheck(value: unknown): Check | null {
	if (!isRecord(value)) return null;
	const { observation, photo } = value;
	const text = localized(value.text);
	const sources = pageLinks(value.sources, IDENTIFICATION_BOUNDS.sources);
	if (
		typeof observation !== "string" ||
		!OBSERVATIONS.has(observation) ||
		!isPhoto(photo) ||
		!text ||
		!sources
	) {
		return null;
	}
	return {
		observation: observation as Check["observation"],
		photo,
		text,
		sources,
	};
}

type IdentifiedObject = IdentificationResult["objects"][number];

function toObject(value: unknown): IdentifiedObject | null {
	if (!isRecord(value)) return null;
	const { role, label, reference, confidence, level, remaining } = value;
	if (
		typeof role !== "string" ||
		!ROLES.has(role) ||
		typeof label !== "string" ||
		!(reference === null || typeof reference === "string") ||
		!isPercent(confidence) ||
		typeof level !== "string" ||
		!IDENTIFICATION_LEVELS.has(level) ||
		!Array.isArray(remaining) ||
		!remaining.every((r) => typeof r === "string") ||
		!Array.isArray(value.checks)
	) {
		return null;
	}
	const checks = value.checks
		.slice(0, IDENTIFICATION_BOUNDS.checks)
		.map(toCheck);
	const pages = pageLinks(value.pages, IDENTIFICATION_BOUNDS.pages);
	if (checks.some((c) => c === null) || !pages) return null;
	return {
		role: role as IdentifiedObject["role"],
		label: cut(label, IDENTIFICATION_BOUNDS.label),
		reference:
			reference === null ? null : cut(reference, IDENTIFICATION_BOUNDS.label),
		confidence,
		level: level as IdentifiedObject["level"],
		remaining: (remaining as string[])
			.slice(0, IDENTIFICATION_BOUNDS.remaining)
			.map((r) => cut(r, IDENTIFICATION_BOUNDS.label)),
		checks: checks as Check[],
		pages,
	};
}

type PhotoObservation = IdentificationResult["photoObservations"][number];
type Search = IdentificationResult["searches"][number];

function toObservation(value: unknown): PhotoObservation | null {
	if (!isRecord(value)) return null;
	const { kind, note, photo } = value;
	if (
		typeof kind !== "string" ||
		!PHOTO_KINDS.has(kind) ||
		typeof note !== "string" ||
		!isPhoto(photo)
	) {
		return null;
	}
	return {
		kind: kind as PhotoObservation["kind"],
		note: cut(note, IDENTIFICATION_BOUNDS.sentence),
		photo,
	};
}

function toSearch(value: unknown): Search | null {
	if (!isRecord(value)) return null;
	const { kind, query, pagesRead } = value;
	if (
		typeof kind !== "string" ||
		!SEARCH_KINDS.has(kind) ||
		typeof query !== "string" ||
		!Array.isArray(pagesRead) ||
		!pagesRead.every((d) => typeof d === "string")
	) {
		return null;
	}
	return {
		kind: kind as Search["kind"],
		query: cut(query, EVENT_BOUNDS.query),
		pagesRead: (pagesRead as string[])
			.slice(0, IDENTIFICATION_BOUNDS.pagesRead)
			.map((d) => cut(d, IDENTIFICATION_BOUNDS.domain)),
	};
}

/** Les éléments de `value` (au plus `max`) convertis par `convert` ; `null` si l'un est invalide. */
function convertAll<T>(
	value: unknown,
	max: number,
	convert: (item: unknown) => T | null,
): T[] | null {
	if (!Array.isArray(value)) return null;
	const out = value.slice(0, max).map(convert);
	return out.every((item) => item !== null) ? (out as T[]) : null;
}

/**
 * `IdentificationOut` reçu de l'API, vérifié puis recopié champ par champ : seuls les
 * champs connus sont relayés à la page, chaînes et tableaux bornés, liens en `https://`
 * seulement. `null` : champ obligatoire manquant ou invalide. Le bloc `debug` du superuser
 * n'est vérifié qu'en surface, comme celui d'une analyse.
 */
export function toIdentificationResult(
	value: unknown,
): IdentificationResult | null {
	if (!isRecord(value)) return null;
	const { status, level, remaining, debug, sellerQuestion, titleMismatch } =
		value;
	const objects = convertAll(value.objects, MAX_OBJECTS, toObject);
	const observations = convertAll(
		value.photoObservations,
		IDENTIFICATION_BOUNDS.photoObservations,
		toObservation,
	);
	const searches = convertAll(
		value.searches,
		IDENTIFICATION_BOUNDS.searches,
		toSearch,
	);
	const question = sellerQuestion === null ? null : localized(sellerQuestion);
	if (
		!Number.isInteger(value.identificationId) ||
		typeof status !== "string" ||
		!IDENTIFICATION_STATUSES.has(status) ||
		!isPercent(value.confidence) ||
		typeof level !== "string" ||
		!IDENTIFICATION_LEVELS.has(level) ||
		!objects ||
		(Array.isArray(value.objects) && value.objects.length > MAX_OBJECTS) ||
		!observations ||
		!searches ||
		(sellerQuestion !== null && !question) ||
		!(titleMismatch === null || typeof titleMismatch === "string") ||
		typeof value.verifiedCriteria !== "boolean" ||
		typeof value.unsourced !== "boolean" ||
		!isCount(value.imagesAnalyzed) ||
		typeof value.fromCache !== "boolean" ||
		typeof value.identifiedAt !== "string" ||
		!(
			remaining === undefined ||
			remaining === null ||
			(isRecord(remaining) &&
				(remaining.scans === null || isCount(remaining.scans)))
		) ||
		!(debug === undefined || debug === null || isRecord(debug))
	) {
		return null;
	}
	const out: IdentificationResult = {
		identificationId: value.identificationId as number,
		status: status as IdentificationResult["status"],
		confidence: value.confidence,
		level: level as IdentificationResult["level"],
		objects,
		sellerQuestion: question,
		titleMismatch:
			titleMismatch === null
				? null
				: cut(titleMismatch, IDENTIFICATION_BOUNDS.title),
		photoObservations: observations,
		searches,
		verifiedCriteria: value.verifiedCriteria,
		unsourced: value.unsourced,
		imagesAnalyzed: value.imagesAnalyzed,
		fromCache: value.fromCache,
		identifiedAt: cut(value.identifiedAt, IDENTIFICATION_BOUNDS.date),
	};
	if (remaining !== undefined) {
		out.remaining =
			remaining === null
				? null
				: { scans: (remaining as { scans: number | null }).scans };
	}
	if (isRecord(debug)) out.debug = debug as IdentificationResult["debug"];
	return out;
}

function stage(data: Record<string, unknown>): ScanProgressEvent | null {
	const { stage: name, count } = data;
	if (typeof name !== "string" || !STAGES.has(name)) return null;
	if (count !== undefined && !isCount(count)) return null;
	const event = {
		type: "stage",
		stage: name as Extract<ScanProgressEvent, { type: "stage" }>["stage"],
	} as const;
	return count === undefined ? event : { ...event, count };
}

function progress(
	event: string,
	data: Record<string, unknown>,
): ScanProgressEvent | null {
	switch (event) {
		case "stage":
			return stage(data);
		case "thinking":
			if (!isCount(data.part) || typeof data.text !== "string") return null;
			return {
				type: "thinking",
				part: data.part,
				text: cut(data.text, EVENT_BOUNDS.text),
			};
		case "search":
			if (
				!isCount(data.id) ||
				typeof data.query !== "string" ||
				typeof data.aspect !== "string" ||
				!ASPECTS.has(data.aspect)
			) {
				return null;
			}
			return {
				type: "search",
				id: data.id,
				query: cut(data.query, EVENT_BOUNDS.query),
				aspect: data.aspect as SearchAspect,
			};
		case "page_read":
			if (typeof data.domain !== "string" || typeof data.ok !== "boolean") {
				return null;
			}
			return {
				type: "page_read",
				domain: cut(data.domain, EVENT_BOUNDS.domain),
				ok: data.ok,
			};
		case "criteria_cached":
			return isCount(data.count)
				? { type: "criteria_cached", count: data.count }
				: null;
		case "identification": {
			const identification = toIdentificationResult(data);
			return identification
				? { ...identification, type: "identification" }
				: null;
		}
		case "identification_error":
			return typeof data.code === "string" && ERROR_CODE.test(data.code)
				? { type: "identification_error", code: data.code }
				: null;
		case "search_done": {
			const { id, ok, count, domains } = data;
			if (
				!isCount(id) ||
				typeof ok !== "boolean" ||
				!isCount(count) ||
				!Array.isArray(domains) ||
				!domains.every((d) => typeof d === "string")
			) {
				return null;
			}
			return {
				type: "search_done",
				id,
				ok,
				count,
				domains: domains
					.slice(0, EVENT_BOUNDS.domains)
					.map((d: string) => cut(d, EVENT_BOUNDS.domain)),
			};
		}
		default:
			return null;
	}
}

function parseJson(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

/**
 * Événement du flux validé et borné, prêt à être relayé à la page : une progression,
 * ou la fin du flux (`result` ou `error`). `null` : événement inconnu ou invalide, ignoré.
 * Seul un `result` invalide n'est pas ignoré : il donne l'erreur `invalid_response`.
 * Seuls les champs connus sont recopiés. `purpose` : la forme attendue du `result`.
 */
export function parseStreamMessage(
	m: SseMessage,
	purpose: "identify" | "analyze" = "analyze",
): ScanProgressEvent | StreamOutcome | null {
	const data = parseJson(m.data);
	if (m.event === "result") {
		if (purpose === "identify") {
			const identification = toIdentificationResult(data);
			return identification
				? { type: "result", result: identification }
				: { type: "error", code: "invalid_response" };
		}
		if (!isAnalysisResult(data))
			return { type: "error", code: "invalid_response" };
		if (data.identification === undefined || data.identification === null)
			return { type: "result", result: data };
		// L'identification embarquée est recopiée comme celle d'un flux `identify` ;
		// invalide, elle devient null et l'analyse est gardée.
		return {
			type: "result",
			result: {
				...data,
				identification: toIdentificationResult(data.identification),
			},
		};
	}
	if (!isRecord(data)) return null;
	if (m.event === "error") {
		// Le code seul : jamais le message ni les détails de l'erreur.
		return typeof data.code === "string" && ERROR_CODE.test(data.code)
			? { type: "error", code: data.code }
			: null;
	}
	return progress(m.event, data);
}
