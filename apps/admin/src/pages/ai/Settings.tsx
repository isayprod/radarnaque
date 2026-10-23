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
type NumberKey = {
	[K in keyof Values]: Values[K] extends number ? K : never;
}[keyof Values];

const FIELDS: {
	key: NumberKey;
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
	{
		key: "identificationCacheTtlHours",
		label: "Durée du cache de l'identification (heures)",
		hint: "En heures, de 1 à 2160.",
		min: 1,
		max: 2160,
	},
	{
		key: "criteriaTtlDays",
		label: "Durée de validité des critères (jours)",
		hint: "En jours, de 1 à 730.",
		min: 1,
		max: 730,
	},
	{
		key: "criteriaMaxSearches",
		label: "Recherches web des critères",
		hint: "De 0 à 5 ; 0 désactive la recherche.",
		min: 0,
		max: 5,
	},
	{
		key: "criteriaMaxPages",
		label: "Pages web lues pour les critères",
		hint: "De 0 à 5 ; 0 désactive la lecture.",
		min: 0,
		max: 5,
	},
	{
		key: "identifyRetryThreshold",
		label: "Seuil de relance de l'identification",
		hint: "Confiance de 0 à 100 sous laquelle l'identification est relancée.",
		min: 0,
		max: 100,
	},
	{
		key: "identifyImageSide",
		label: "Côté maximal des photos (px)",
		hint: "En pixels, de 768 à 1536.",
		min: 768,
		max: 1536,
	},
];

const PRIVACY_WARNING =
	"Pensez à mettre à jour la page /privacy, qui annonce jusqu'à 3 recherches.";

type Drafts = Record<NumberKey, string>;

function draftsOf(settings: Values): Drafts {
	return Object.fromEntries(
		FIELDS.map((f) => [f.key, String(settings[f.key])]),
	) as Drafts;
}

export function Settings({
	api,
	settings,
	models,
	onOverview,
}: {
	api: AdminApi;
	settings: Values;
	models: Overview["models"];
	onOverview: (overview: Overview) => void;
}) {
	const [drafts, setDrafts] = useState(() => draftsOf(settings));
	const [sendsPhotos, setSendsPhotos] = useState(settings.scamSendsPhotos);
	// "" : aucun modèle de relance.
	const [escalation, setEscalation] = useState(
		String(settings.identifyEscalationModelId ?? ""),
	);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Les valeurs enregistrées font foi : les champs les reprennent après chaque mise à jour.
	const saved = JSON.stringify(settings);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `saved` résume `settings`
	useEffect(() => {
		setDrafts(draftsOf(settings));
		setSendsPhotos(settings.scamSendsPhotos);
		setEscalation(String(settings.identifyEscalationModelId ?? ""));
	}, [saved]);

	const parsed = FIELDS.map((f) => {
		const raw = drafts[f.key];
		const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		return { ...f, value, valid: value >= f.min && value <= f.max };
	});
	const allValid = parsed.every((f) => f.valid);
	const numberChanges = parsed.filter(
		(f) => f.valid && f.value !== settings[f.key],
	);
	const photosChanged = sendsPhotos !== settings.scamSendsPhotos;
	const escalationId = escalation === "" ? null : Number(escalation);
	const escalationChanged = escalationId !== settings.identifyEscalationModelId;
	const changeCount =
		numberChanges.length + Number(photosChanged) + Number(escalationChanged);

	function review(event: FormEvent) {
		event.preventDefault();
		if (allValid && changeCount > 0) setConfirming(true);
	}

	async function save() {
		setError(null);
		const body: Partial<Values> = {};
		for (const change of numberChanges) body[change.key] = change.value;
		if (photosChanged) body.scamSendsPhotos = sendsPhotos;
		if (escalationChanged) body.identifyEscalationModelId = escalationId;
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

	function modelName(id: number | null): string {
		const model = models.find((m) => m.id === id);
		return model ? `${model.provider} / ${model.slug}` : "aucun";
	}
	const yesNo = (value: boolean) => (value ? "oui" : "non");

	const lines = numberChanges.map(
		(c) => `${c.label} : ${settings[c.key]} → ${c.value}`,
	);
	if (photosChanged) {
		lines.push(
			`Photos envoyées à l'analyse d'arnaque : ${yesNo(settings.scamSendsPhotos)} → ${yesNo(sendsPhotos)}`,
		);
	}
	if (escalationChanged) {
		lines.push(
			`Modèle de relance : ${modelName(settings.identifyEscalationModelId)} → ${modelName(escalationId)}`,
		);
	}
	const privacy = numberChanges.some((c) => c.key === "maxWebSearches");

	return (
		<Section title="Réglages">
			<form onSubmit={review} noValidate className="space-y-3">
				<div className="flex flex-wrap items-start gap-4">
					{parsed.map((f) => {
						const id = `setting-${f.key}`;
						return (
							<div key={f.key} className="max-w-56 space-y-1">
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
					<div className="max-w-56 space-y-1">
						<label
							className="text-sm font-medium"
							htmlFor="setting-identifyEscalationModelId"
						>
							Modèle de relance de l'identification
						</label>
						<select
							id="setting-identifyEscalationModelId"
							value={escalation}
							onChange={(event) => setEscalation(event.target.value)}
							className={`${field} block`}
						>
							<option value="">Aucun</option>
							{models.map((model) => (
								<option key={model.id} value={model.id}>
									{model.provider} / {model.slug}
								</option>
							))}
						</select>
					</div>
				</div>
				<label className="flex items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						checked={sendsPhotos}
						onChange={(event) => setSendsPhotos(event.target.checked)}
					/>
					Envoyer les photos à l'analyse d'arnaque
				</label>
				<button
					type="submit"
					disabled={!allValid || changeCount === 0}
					className={primaryButton}
				>
					Enregistrer
				</button>
			</form>
			<ErrorLine message={error} />

			{confirming && (
				<ConfirmDialog
					title="Modifier les réglages"
					message={`${lines.join(" ; ")}.${privacy ? ` ${PRIVACY_WARNING}` : ""}`}
					confirmLabel="Enregistrer"
					onCancel={() => setConfirming(false)}
					onConfirm={save}
				/>
			)}
		</Section>
	);
}
