import type { components } from "@radarnaque/shared";
import type { ReactNode } from "react";
import { ApiFailure } from "../../api";

export type Overview = components["schemas"]["AiOverviewOut"];

export const secondaryButton =
	"rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
export const primaryButton =
	"rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
export const field =
	"rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-brand-600";

export const LIMIT_MESSAGE =
	"Limite d'essais atteinte, réessayez dans une heure.";

export function Section({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className="space-y-3">
			<h2 className="text-base font-semibold">{title}</h2>
			{children}
		</section>
	);
}

/** Texte clair d'une erreur de modification. Les 409 et 422 portent le message de l'API. */
export function actionMessage(error: unknown): string {
	if (error instanceof ApiFailure) {
		if (error.status === 404) return "Élément introuvable.";
		if (error.status === 409 || error.status === 422) {
			return error.message === error.code
				? "La valeur est refusée."
				: error.message;
		}
	}
	return "L'action a échoué, réessayez.";
}

/** Texte d'une erreur d'essai : la limite horaire a son propre message. */
export function probeMessage(error: unknown): string {
	if (error instanceof ApiFailure && error.status === 429) {
		return LIMIT_MESSAGE;
	}
	return "L'essai a échoué, réessayez.";
}

/** Chaque erreur est annoncée, ou rien (zone réservée pour que la page ne saute pas). */
export function ErrorLine({ message }: { message: string | null }) {
	return (
		<div aria-live="polite" className="min-h-5 text-sm">
			{message && (
				<p role="alert" className="text-red-700">
					{message}
				</p>
			)}
		</div>
	);
}
