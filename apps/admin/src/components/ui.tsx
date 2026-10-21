import type { ReactNode } from "react";
import { ApiFailure } from "../api";

export const primaryButton =
	"rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
export const secondaryButton =
	"rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
export const dangerButton =
	"rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-60";
export const field =
	"rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-brand-600";

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

/** Une ligne « libellé : valeur » d'une liste de définitions. */
export function Term({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex gap-2">
			<dt className="w-40 shrink-0 text-slate-500">{label}</dt>
			<dd className="min-w-0 break-all">{children}</dd>
		</div>
	);
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

// Les 409 des routes /api/admin/users/* se distinguent par `details.reason`, jamais par
// le texte du message.
const CONFLICTS: Record<string, string> = {
	last_admin: "Impossible : c'est le dernier admin.",
	self: "Impossible sur votre propre compte.",
	stripe: "Géré dans Stripe.",
};

/** Texte clair d'une erreur de modification : raison du 409, limite de débit, sinon le
 * message de l'API (en français), sinon un message générique. */
export function actionMessage(error: unknown): string {
	if (error instanceof ApiFailure) {
		const { reason } = error.details;
		if (
			error.status === 409 &&
			typeof reason === "string" &&
			reason in CONFLICTS
		) {
			return CONFLICTS[reason];
		}
		if (error.status === 429) return "Trop de demandes, réessayez plus tard.";
		if (error.message !== error.code) return error.message;
	}
	return "L'action a échoué, réessayez.";
}
