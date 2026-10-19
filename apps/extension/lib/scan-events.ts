import type {
	AnalysisResult,
	ScanProgressEvent,
	SearchAspect,
} from "@radarnaque/shared";
import { cut } from "./scan-payload";
import type { SseMessage } from "./sse";

/** Fin du flux telle que le port la poste à l'onglet. */
export type StreamOutcome =
	| { type: "result"; result: AnalysisResult }
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
	"writing",
]);
const ASPECTS: ReadonlySet<string> = new Set<SearchAspect>([
	"model",
	"price",
	"scam",
	"other",
]);
const LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
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
 * Seuls les champs connus sont recopiés.
 */
export function parseStreamMessage(
	m: SseMessage,
): ScanProgressEvent | StreamOutcome | null {
	const data = parseJson(m.data);
	if (m.event === "result") {
		return isAnalysisResult(data)
			? { type: "result", result: data }
			: { type: "error", code: "invalid_response" };
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
