import type { components } from "@radarnaque/shared";
import { useRef, useState } from "react";
import type { AdminApi } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
	actionMessage,
	ErrorLine,
	field,
	primaryButton,
	Section,
	secondaryButton,
} from "../../components/ui";
import { formatDateTime } from "../../format";
import { Editor, textarea } from "./Prompts";
import type { Overview } from "./shared";

type Step = Overview["steps"][number];
type StepPrompt = Step["prompts"][number];
type PromptText = components["schemas"]["PromptTextOut"];

const LABELS: Record<Step["code"], string> = {
	read_photos: "Lecture des photos",
	criteria: "Critères de distinction",
	identify: "Identification",
};

export function Steps({
	api,
	overview,
	onOverview,
	reload,
}: {
	api: AdminApi;
	overview: Overview;
	onOverview: (overview: Overview) => void;
	reload: () => Promise<void>;
}) {
	return (
		<Section title="Étapes de l'identification">
			<p className="text-xs text-slate-500">
				Un modèle et un prompt par étape, indépendants du type de scan.
			</p>
			<div className="space-y-4">
				{overview.steps.map((step) => (
					<StepCard
						key={step.code}
						api={api}
						step={step}
						models={overview.models}
						onOverview={onOverview}
						reload={reload}
					/>
				))}
			</div>
		</Section>
	);
}

// Une seule zone de texte par carte : lecture d'une version ou rédaction de la suivante.
type Pane =
	| { kind: "loading" }
	| { kind: "read"; version: number; text: string }
	| { kind: "edit"; text: string };

function StepCard({
	api,
	step,
	models,
	onOverview,
	reload,
}: {
	api: AdminApi;
	step: Step;
	models: Overview["models"];
	onOverview: (overview: Overview) => void;
	reload: () => Promise<void>;
}) {
	const label = LABELS[step.code];
	const base = `/api/admin/ai/steps/${step.code}`;
	const [pane, setPane] = useState<Pane | null>(null);
	const [modelToSet, setModelToSet] = useState<
		Overview["models"][number] | null
	>(null);
	const [toActivate, setToActivate] = useState<StepPrompt | null>(null);
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Change à chaque ouverture ou fermeture : la réponse d'une ouverture abandonnée est ignorée.
	const opening = useRef(0);

	function close() {
		opening.current += 1;
		setPane(null);
	}

	async function open(id: number, then: (loaded: PromptText) => Pane) {
		const mine = ++opening.current;
		setError(null);
		setCreated(null);
		setPane({ kind: "loading" });
		try {
			const loaded = await api.get<PromptText>(`/api/admin/ai/prompts/${id}`);
			if (mine === opening.current) setPane(then(loaded));
		} catch (failure) {
			if (mine !== opening.current) return;
			setPane(null);
			setError(actionMessage(failure));
		}
	}

	function startNew() {
		if (step.activePromptId === null) {
			setError(null);
			setCreated(null);
			setPane({ kind: "edit", text: "" });
			return;
		}
		void open(step.activePromptId, (loaded) => ({
			kind: "edit",
			text: loaded.systemPrompt,
		}));
	}

	async function create(text: string) {
		setCreating(true);
		setError(null);
		let version: number;
		try {
			const made = await api.send<PromptText>("POST", `${base}/prompts`, {
				systemPrompt: text,
			});
			version = made.version;
		} catch (failure) {
			setError(actionMessage(failure));
			setCreating(false);
			return;
		}
		close();
		setCreated(`Version ${version} créée.`);
		try {
			await reload();
		} catch {
			setError(
				"La version est créée, mais la liste n'a pas pu être rechargée.",
			);
		} finally {
			setCreating(false);
		}
	}

	// Les boîtes se ferment dans tous les cas ; l'erreur éventuelle s'affiche dans la carte.
	async function setModel(model: Overview["models"][number]) {
		setError(null);
		setCreated(null);
		try {
			onOverview(
				await api.send<Overview>("POST", `${base}/active-model`, {
					modelId: model.id,
				}),
			);
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setModelToSet(null);
		}
	}

	async function activate(prompt: StepPrompt) {
		setError(null);
		setCreated(null);
		try {
			onOverview(
				await api.send<Overview>(
					"POST",
					`${base}/prompts/${prompt.id}/activate`,
				),
			);
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setToActivate(null);
		}
	}

	const selectId = `step-${step.code}-model`;
	return (
		<article
			aria-label={label}
			className="space-y-3 rounded-lg border border-slate-200 p-4"
		>
			<h3 className="text-sm font-semibold">{label}</h3>
			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor={selectId}>
					Modèle de l'étape {label}
				</label>
				<select
					id={selectId}
					value={step.activeModelId}
					onChange={(event) => {
						const model = models.find(
							(m) => m.id === Number(event.target.value),
						);
						if (model !== undefined && model.id !== step.activeModelId) {
							setModelToSet(model);
						}
					}}
					className={`${field} block`}
				>
					{models.map((model) => (
						<option
							key={model.id}
							value={model.id}
							disabled={!model.knownProvider && model.id !== step.activeModelId}
						>
							{model.provider} / {model.slug}
						</option>
					))}
				</select>
			</div>

			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm">
					<thead className="text-xs text-slate-500">
						<tr>
							<th className="py-1 pr-4 font-medium">Version</th>
							<th className="py-1 pr-4 font-medium">Créée le</th>
							<th className="py-1 pr-4 font-medium">État</th>
							<th className="py-1 font-medium">Actions</th>
						</tr>
					</thead>
					<tbody>
						{step.prompts.map((prompt) => (
							<tr key={prompt.id} className="border-t border-slate-100">
								<td className="py-1 pr-4">{prompt.version}</td>
								<td className="py-1 pr-4 whitespace-nowrap">
									{formatDateTime(prompt.createdAt)}
								</td>
								<td className="py-1 pr-4">
									{prompt.active ? (
										<span className="font-medium text-green-700">Active</span>
									) : (
										"—"
									)}
								</td>
								<td className="py-1">
									<div className="flex flex-wrap gap-2">
										<button
											type="button"
											onClick={() =>
												void open(prompt.id, (loaded) => ({
													kind: "read",
													version: loaded.version,
													text: loaded.systemPrompt,
												}))
											}
											className={secondaryButton}
										>
											Consulter
										</button>
										{!prompt.active && (
											<button
												type="button"
												onClick={() => setToActivate(prompt)}
												className={secondaryButton}
											>
												Activer
											</button>
										)}
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{pane === null && (
				<div>
					<button type="button" onClick={startNew} className={primaryButton}>
						Nouvelle version
					</button>
				</div>
			)}
			{pane?.kind === "loading" && (
				<p className="text-sm text-slate-500">Chargement du texte…</p>
			)}
			{pane?.kind === "read" && (
				<div className="space-y-2">
					<label
						className="text-sm font-medium"
						htmlFor={`step-${step.code}-read`}
					>
						Texte de la version {pane.version}
					</label>
					<textarea
						id={`step-${step.code}-read`}
						readOnly
						rows={14}
						value={pane.text}
						className={textarea}
					/>
					<button type="button" onClick={close} className={secondaryButton}>
						Fermer
					</button>
				</div>
			)}
			{pane?.kind === "edit" && (
				<Editor
					id={`step-${step.code}`}
					initial={pane.text}
					sending={creating}
					onSubmit={(text) => void create(text)}
					onCancel={close}
				/>
			)}

			<div aria-live="polite" className="min-h-5 text-sm text-green-700">
				{created}
			</div>
			<ErrorLine message={error} />

			{modelToSet !== null && (
				<ConfirmDialog
					title={`Utiliser ${modelToSet.slug} pour ${label}`}
					message={`Les identifications repartiront de zéro pour ce modèle (cache).`}
					confirmLabel="Changer le modèle"
					onCancel={() => setModelToSet(null)}
					onConfirm={() => setModel(modelToSet)}
				/>
			)}
			{toActivate !== null && (
				<ConfirmDialog
					title={`Activer la version ${toActivate.version} (${label})`}
					message="Les identifications repartiront de zéro pour cette version du prompt (cache)."
					confirmLabel="Activer la version"
					onCancel={() => setToActivate(null)}
					onConfirm={() => activate(toActivate)}
				/>
			)}
		</article>
	);
}
