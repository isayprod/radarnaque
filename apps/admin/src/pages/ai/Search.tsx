import type { components } from "@radarnaque/shared";
import { type FormEvent, type ReactNode, useState } from "react";
import type { AdminApi } from "../../api";
import { ErrorLine, field, primaryButton, Section } from "../../components/ui";
import { type Overview, probeMessage } from "./shared";

type SearchStatus = Overview["search"];
type SearchTest = components["schemas"]["SearchTestOut"];

const STATES: Record<SearchStatus["status"], { label: string; tone: string }> =
	{
		ok: { label: "Recherche disponible", tone: "text-green-700" },
		down: { label: "Recherche indisponible", tone: "text-orange-700" },
		disabled: { label: "Recherche désactivée", tone: "text-slate-500" },
	};

const MAX_QUERY = 200;

export function Search({
	api,
	search,
}: {
	api: AdminApi;
	search: SearchStatus;
}) {
	const [query, setQuery] = useState("");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<SearchTest | null>(null);
	const [error, setError] = useState<string | null>(null);
	const state = STATES[search.status];
	const trimmed = query.trim();

	async function run(event: FormEvent) {
		event.preventDefault();
		if (trimmed === "" || running) return;
		setRunning(true);
		setResult(null);
		setError(null);
		try {
			setResult(
				await api.send<SearchTest>("POST", "/api/admin/ai/search-test", {
					query: trimmed,
				}),
			);
		} catch (failure) {
			setError(probeMessage(failure));
		} finally {
			setRunning(false);
		}
	}

	return (
		<Section title="Recherche web">
			<dl className="space-y-1 text-sm">
				<div className="flex gap-2">
					<dt className="w-40 shrink-0 text-slate-500">État</dt>
					<dd className={`font-medium ${state.tone}`}>{state.label}</dd>
				</div>
				<div className="flex gap-2">
					<dt className="w-40 shrink-0 text-slate-500">Moteur</dt>
					<dd>{search.backend}</dd>
				</div>
				<div className="flex gap-2">
					<dt className="w-40 shrink-0 text-slate-500">URL</dt>
					<dd className="break-all">{search.url ?? "—"}</dd>
				</div>
				<div className="flex gap-2">
					<dt className="w-40 shrink-0 text-slate-500">Cache des recherches</dt>
					<dd>
						{search.cacheEntries === null
							? "—"
							: `${search.cacheEntries} ${search.cacheEntries > 1 ? "entrées" : "entrée"}`}
					</dd>
				</div>
			</dl>

			<form
				onSubmit={run}
				noValidate
				className="flex flex-wrap items-end gap-4"
			>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="search-query">
						Requête de test
					</label>
					<input
						id="search-query"
						autoComplete="off"
						maxLength={MAX_QUERY}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className={`${field} block w-96 max-w-full`}
					/>
				</div>
				<button
					type="submit"
					disabled={trimmed === "" || running}
					className={primaryButton}
				>
					Tester une recherche
				</button>
			</form>
			<ErrorLine message={error} />
			{result !== null && <Outcome result={result} />}
		</Section>
	);
}

function Outcome({ result }: { result: SearchTest }) {
	let body: ReactNode;
	if (result.status === "disabled") {
		body = <p>La recherche web est désactivée.</p>;
	} else if (result.status === "down") {
		body = <p className="text-orange-700">Recherche indisponible.</p>;
	} else if (result.count === 0) {
		body = <p>Aucun résultat.</p>;
	} else {
		body = (
			<>
				<p className="font-medium">
					{result.count} {result.count > 1 ? "résultats" : "résultat"}
				</p>
				<pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap break-words">
					{result.text}
				</pre>
			</>
		);
	}
	return (
		<div
			role="status"
			className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm"
		>
			{body}
		</div>
	);
}
