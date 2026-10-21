import type { components } from "@radarnaque/shared";
import { useRef, useState } from "react";
import type { AdminApi } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { formatDateTime } from "../../format";
import {
	actionMessage,
	ErrorLine,
	type Overview,
	primaryButton,
	Section,
	secondaryButton,
} from "./shared";

type Prompt = Overview["prompts"][number];
type PromptText = components["schemas"]["PromptTextOut"];

const MIN_LENGTH = 200;
const MAX_LENGTH = 20_000;

const textarea =
	"block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-brand-600";

// Une seule zone de texte à la fois : lecture d'une version ou rédaction de la suivante.
type Pane =
	| { kind: "loading" }
	| { kind: "read"; version: number; text: string }
	| { kind: "edit"; text: string };

export function Prompts({
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
	const [pane, setPane] = useState<Pane | null>(null);
	const [toActivate, setToActivate] = useState<Prompt | null>(null);
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

	function consult(prompt: Prompt) {
		void open(prompt.id, (loaded) => ({
			kind: "read",
			version: loaded.version,
			text: loaded.systemPrompt,
		}));
	}

	function startNew() {
		if (overview.activePromptVersionId === null) {
			setError(null);
			setCreated(null);
			setPane({ kind: "edit", text: "" });
			return;
		}
		void open(overview.activePromptVersionId, (loaded) => ({
			kind: "edit",
			text: loaded.systemPrompt,
		}));
	}

	async function create(text: string) {
		setCreating(true);
		setError(null);
		let version: number;
		try {
			const made = await api.send<PromptText>("POST", "/api/admin/ai/prompts", {
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

	// La boîte se ferme dans tous les cas ; l'erreur éventuelle s'affiche dans la section.
	async function activate(prompt: Prompt) {
		setError(null);
		setCreated(null);
		try {
			onOverview(
				await api.send<Overview>(
					"POST",
					`/api/admin/ai/prompts/${prompt.id}/activate`,
				),
			);
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setToActivate(null);
		}
	}

	return (
		<Section title="Prompts">
			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm">
					<thead className="text-xs text-slate-500">
						<tr>
							<th className="py-1 pr-4 font-medium">Version</th>
							<th className="py-1 pr-4 font-medium">Créée le</th>
							<th className="py-1 pr-4 font-medium">Analyses</th>
							<th className="py-1 pr-4 font-medium">État</th>
							<th className="py-1 font-medium">Actions</th>
						</tr>
					</thead>
					<tbody>
						{overview.prompts.map((prompt) => (
							<tr key={prompt.id} className="border-t border-slate-100">
								<td className="py-1 pr-4">{prompt.version}</td>
								<td className="py-1 pr-4 whitespace-nowrap">
									{formatDateTime(prompt.createdAt)}
								</td>
								<td className="py-1 pr-4">{prompt.analyses}</td>
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
											onClick={() => consult(prompt)}
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
					<label className="text-sm font-medium" htmlFor="prompt-read">
						Texte de la version {pane.version}
					</label>
					<textarea
						id="prompt-read"
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

			{toActivate !== null && (
				<ConfirmDialog
					title={`Activer la version ${toActivate.version}`}
					message="Les analyses repartiront de zéro pour cette version du prompt (cache)."
					confirmLabel="Activer la version"
					onCancel={() => setToActivate(null)}
					onConfirm={() => activate(toActivate)}
				/>
			)}
		</Section>
	);
}

function Editor({
	initial,
	sending,
	onSubmit,
	onCancel,
}: {
	initial: string;
	sending: boolean;
	onSubmit: (text: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState(initial);
	const valid = text.length >= MIN_LENGTH && text.length <= MAX_LENGTH;
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				if (valid && !sending) onSubmit(text);
			}}
			className="space-y-2"
		>
			<label className="text-sm font-medium" htmlFor="prompt-edit">
				Texte de la nouvelle version
			</label>
			<textarea
				id="prompt-edit"
				rows={14}
				value={text}
				onChange={(event) => setText(event.target.value)}
				aria-describedby="prompt-counter prompt-reminder"
				className={textarea}
			/>
			<p
				id="prompt-counter"
				className={`text-xs ${valid ? "text-slate-500" : "text-red-700"}`}
			>
				{text.length} caractères ({MIN_LENGTH} à 20 000)
			</p>
			<p id="prompt-reminder" className="text-xs text-slate-500">
				La réponse doit rester au format JSON attendu : le schéma est ajouté par
				le serveur en mode json_object.
			</p>
			<div className="flex gap-2">
				<button
					type="submit"
					disabled={!valid || sending}
					className={primaryButton}
				>
					Créer la version
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={sending}
					className={secondaryButton}
				>
					Annuler
				</button>
			</div>
		</form>
	);
}
