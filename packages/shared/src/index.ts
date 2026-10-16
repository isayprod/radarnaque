import type { components } from "./api";

export type { components, paths } from "./api";

export type Me = components["schemas"]["MeOut"];

export type ApiErrorBody = {
	error: { code: string; message: string; details: Record<string, unknown> };
};

export type Locale = "fr" | "nl";
