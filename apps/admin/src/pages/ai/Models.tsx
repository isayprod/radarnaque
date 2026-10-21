import type { components } from "@radarnaque/shared";
import { type FormEvent, useState } from "react";
import type { AdminApi } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
	actionMessage,
	ErrorLine,
	field,
	type Overview,
	primaryButton,
	probeMessage,
	Section,
	secondaryButton,
} from "./shared";

type Model = Overview["models"][number];
type ModelTest = components["schemas"]["ModelTestOut"];

const SLUG = /^\S{1,200}$/;

const TEST_ERRORS: Record<NonNullable<ModelTest["error"]>, string> = {
	transport: "Erreur de connexion au fournisseur.",
	timeout: "Le fournisseur n'a pas répondu à temps.",
	invalid_response: "Réponse du modèle invalide.",
	configuration: "Clé du fournisseur absente ou configuration incomplète.",
};

// Résultat du dernier essai : une seule zone, remplacée à chaque essai.
type Outcome =
	| { slug: string; result: ModelTest }
	| { slug: string; failure: string };

export function Models({
	api,
	overview,
	onOverview,
}: {
	api: AdminApi;
	overview: Overview;
	onOverview: (overview: Overview) => void;
}) {
	const [provider, setProvider] = useState("");
	const [slug, setSlug] = useState("");
	const [adding, setAdding] = useState(false);
	const [toActivate, setToActivate] = useState<Model | null>(null);
	const [testing, setTesting] = useState<number | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);

	const chosen = provider || overview.providers[0]?.code || "";
	const slugValid = SLUG.test(slug);

	async function add(event: FormEvent) {
		event.preventDefault();
		if (!slugValid || chosen === "" || adding) return;
		setAdding(true);
		setError(null);
		try {
			onOverview(
				await api.send<Overview>("POST", "/api/admin/ai/models", {
					provider: chosen,
					slug,
				}),
			);
			setSlug("");
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setAdding(false);
		}
	}

	// La boîte se ferme dans tous les cas ; l'erreur éventuelle s'affiche dans la section.
	async function activate(model: Model) {
		setError(null);
		try {
			onOverview(
				await api.send<Overview>("POST", "/api/admin/ai/active-model", {
					modelId: model.id,
				}),
			);
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setToActivate(null);
		}
	}

	async function test(model: Model) {
		if (testing !== null) return;
		setTesting(model.id);
		setOutcome(null);
		try {
			const result = await api.send<ModelTest>(
				"POST",
				`/api/admin/ai/models/${model.id}/test`,
			);
			setOutcome({ slug: model.slug, result });
		} catch (failure) {
			setOutcome({ slug: model.slug, failure: probeMessage(failure) });
		} finally {
			setTesting(null);
		}
	}

	return (
		<Section title="Modèles">
			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm">
					<thead className="text-xs text-slate-500">
						<tr>
							<th className="py-1 pr-4 font-medium">Fournisseur</th>
							<th className="py-1 pr-4 font-medium">Slug</th>
							<th className="py-1 pr-4 font-medium">Analyses</th>
							<th className="py-1 pr-4 font-medium">État</th>
							<th className="py-1 font-medium">Actions</th>
						</tr>
					</thead>
					<tbody>
						{overview.models.map((model) => (
							<tr key={model.id} className="border-t border-slate-100">
								<td className="py-1 pr-4">{model.provider}</td>
								<td className="py-1 pr-4 break-all">{model.slug}</td>
								<td className="py-1 pr-4">{model.analyses}</td>
								<td className="py-1 pr-4">
									{model.active ? (
										<span className="font-medium text-green-700">Actif</span>
									) : !model.knownProvider ? (
										<span className="text-orange-700">Fournisseur retiré</span>
									) : (
										"—"
									)}
								</td>
								<td className="py-1">
									<div className="flex flex-wrap gap-2">
										{!model.active && (
											<button
												type="button"
												disabled={!model.knownProvider}
												onClick={() => setToActivate(model)}
												className={secondaryButton}
											>
												Activer
											</button>
										)}
										<button
											type="button"
											disabled={testing !== null}
											onClick={() => void test(model)}
											className={secondaryButton}
										>
											{testing === model.id ? "Essai en cours…" : "Tester"}
										</button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div aria-live="polite" className="text-sm">
				{outcome !== null && <TestOutcome outcome={outcome} />}
			</div>

			<form
				onSubmit={add}
				noValidate
				className="flex flex-wrap items-end gap-4"
			>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="model-provider">
						Fournisseur
					</label>
					<select
						id="model-provider"
						value={chosen}
						onChange={(event) => setProvider(event.target.value)}
						className={`${field} block`}
					>
						{overview.providers.map((p) => (
							<option key={p.code} value={p.code}>
								{p.code}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="model-slug">
						Slug
					</label>
					<input
						id="model-slug"
						autoComplete="off"
						maxLength={200}
						value={slug}
						onChange={(event) => setSlug(event.target.value)}
						aria-describedby="model-slug-hint"
						className={`${field} block w-72`}
					/>
					<p id="model-slug-hint" className="text-xs text-slate-500">
						1 à 200 caractères, sans espace.
					</p>
				</div>
				<button
					type="submit"
					disabled={!slugValid || chosen === "" || adding}
					className={primaryButton}
				>
					Ajouter le modèle
				</button>
			</form>
			<ErrorLine message={error} />

			{toActivate !== null && (
				<ConfirmDialog
					title={`Activer ${toActivate.slug}`}
					message="Les analyses repartiront de zéro pour ce modèle (cache)."
					confirmLabel="Activer le modèle"
					onCancel={() => setToActivate(null)}
					onConfirm={() => activate(toActivate)}
				/>
			)}
		</Section>
	);
}

function TestOutcome({ outcome }: { outcome: Outcome }) {
	if ("failure" in outcome) {
		return (
			<p role="alert" className="text-red-700">
				{outcome.failure}
			</p>
		);
	}
	const { result } = outcome;
	return (
		<div
			role="status"
			className="space-y-2 rounded-lg border border-slate-200 p-3"
		>
			<p className="font-medium">Essai de {outcome.slug}</p>
			{result.ok ? (
				<ul className="space-y-0.5">
					<li>Score : {result.score ?? "—"}</li>
					<li>Durée : {result.durationMs} ms</li>
					<li>
						Tokens : {result.tokensIn} en entrée, {result.tokensOut} en sortie
					</li>
				</ul>
			) : (
				<p className="text-red-700">
					Échec :{" "}
					{result.error ? TEST_ERRORS[result.error] : "erreur inconnue."}
				</p>
			)}
			{result.raw !== "" && (
				<details>
					<summary className="cursor-pointer text-slate-600">
						Réponse brute
					</summary>
					<pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap break-all">
						{result.raw}
					</pre>
				</details>
			)}
		</div>
	);
}
