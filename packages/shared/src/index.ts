import type { components } from "./api";

export type { components, paths } from "./api";
export type {
	CriteriaCachedEvent,
	IdentificationErrorEvent,
	IdentificationEvent,
	PageReadEvent,
	ScanProgressEvent,
	SearchAspect,
	StreamStage,
} from "./stream";

export type Me = components["schemas"]["MeOut"];
export type ScanIn = components["schemas"]["ScanIn"];
export type AnalysisResult = components["schemas"]["AnalysisResultOut"];
export type ScanHistory = components["schemas"]["ScanHistoryOut"];

export type ApiErrorBody = {
	error: { code: string; message: string; details: Record<string, unknown> };
};

export type Locale = "fr" | "nl";
