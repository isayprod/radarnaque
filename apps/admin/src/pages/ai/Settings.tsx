import { type FormEvent, useEffect, useState } from "react";
import type { AdminApi } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
	actionMessage,
	ErrorLine,
	field,
	primaryButton,
	Section,
} from "../../components/ui";
import type { Overview } from "./shared";

type Values = Overview["settings"];
type Key = keyof Values;

const FIELDS: {
	key: Key;
	label: string;
	hint: string;
	min: number;
	max: number;
}[] = [
	{
		key: "cacheTtlHours",
		label: "Durée du cache",
		hint: "En heures, de 1 à 168.",
		min: 1,
		max: 168,
	},
	{
		key: "rateLimitPerMinute",
		label: "Limite de requêtes par minute",
		hint: "Par utilisateur, de 1 à 600.",
		min: 1,
		max: 600,
	},
	{
		key: "maxWebSearches",
		label: "Recherches web par analyse",
		hint: "De 0 à 5 ; 0 désactive la recherche.",
		min: 0,
		max: 5,
	},
];

const PRIVACY_WARNING =
	"Pensez à mettre à jour la page /privacy, qui annonce jusqu'à 3 recherches.";

function draftsOf(settings: Values): Record<Key, string> {
	return {
		cacheTtlHours: String(settings.cacheTtlHours),
		rateLimitPerMinute: String(settings.rateLimitPerMinute),
		maxWebSearches: String(settings.maxWebSearches),
	};
}

export function Settings({
	api,
	settings,
	onOverview,
}: {
	api: AdminApi;
	settings: Values;
	onOverview: (overview: Overview) => void;
}) {
	const [drafts, setDrafts] = useState(() => draftsOf(settings));
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Les valeurs enregistrées font foi : les champs les reprennent après chaque mise à jour.
	useEffect(() => {
		setDrafts(
			draftsOf({
				cacheTtlHours: settings.cacheTtlHours,
				rateLimitPerMinute: settings.rateLimitPerMinute,
				maxWebSearches: settings.maxWebSearches,
			}),
		);
	}, [
		settings.cacheTtlHours,
		settings.rateLimitPerMinute,
		settings.maxWebSearches,
	]);

	const parsed = FIELDS.map((f) => {
		const raw = drafts[f.key];
		const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		return { ...f, value, valid: value >= f.min && value <= f.max };
	});
	const allValid = parsed.every((f) => f.valid);
	const changes = parsed.filter((f) => f.valid && f.value !== settings[f.key]);

	function review(event: FormEvent) {
		event.preventDefault();
		if (allValid && changes.length > 0) setConfirming(true);
	}

	async function save() {
		setError(null);
		const body: Partial<Values> = {};
		for (const change of changes) body[change.key] = change.value;
		try {
			onOverview(
				await api.send<Overview>("PATCH", "/api/admin/ai/settings", body),
			);
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setConfirming(false);
		}
	}

	const summary = changes
		.map((c) => `${c.label} : ${settings[c.key]} → ${c.value}`)
		.join(" ; ");
	const privacy = changes.some((c) => c.key === "maxWebSearches");

	return (
		<Section title="Réglages">
			<form onSubmit={review} noValidate className="space-y-3">
				<div className="flex flex-wrap items-start gap-4">
					{parsed.map((f) => {
						const id = `setting-${f.key}`;
						return (
							<div key={f.key} className="space-y-1">
								<label className="text-sm font-medium" htmlFor={id}>
									{f.label}
								</label>
								<input
									id={id}
									type="number"
									inputMode="numeric"
									min={f.min}
									max={f.max}
									step={1}
									value={drafts[f.key]}
									aria-invalid={!f.valid}
									aria-describedby={`${id}-hint`}
									onChange={(event) =>
										setDrafts({ ...drafts, [f.key]: event.target.value })
									}
									className={`${field} block w-40 aria-invalid:border-red-500`}
								/>
								<p
									id={`${id}-hint`}
									className={`text-xs ${f.valid ? "text-slate-500" : "text-red-700"}`}
								>
									{f.hint}
								</p>
							</div>
						);
					})}
				</div>
				<button
					type="submit"
					disabled={!allValid || changes.length === 0}
					className={primaryButton}
				>
					Enregistrer
				</button>
			</form>
			<ErrorLine message={error} />

			{confirming && (
				<ConfirmDialog
					title="Modifier les réglages"
					message={`${summary}.${privacy ? ` ${PRIVACY_WARNING}` : ""}`}
					confirmLabel="Enregistrer"
					onCancel={() => setConfirming(false)}
					onConfirm={save}
				/>
			)}
		</Section>
	);
}
