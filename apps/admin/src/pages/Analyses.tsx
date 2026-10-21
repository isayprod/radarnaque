import type { components } from "@radarnaque/shared";
import { useEffect, useRef, useState } from "react";
import type { AdminApi } from "../api";
import { Link } from "../components/Link";
import { field, secondaryButton } from "../components/ui";
import { formatDateTime, formatUsd } from "../format";
import { useSession } from "../session";

type AnalysisList = components["schemas"]["AnalysisListOut"];
type Overview = components["schemas"]["AiOverviewOut"];

const SEARCH_MIN = 3;
const SEARCH_DELAY_MS = 300;

// Les sites que l'API connaît (migration 0002) : aucune route ne les liste.
const SITES = ["2ememain.be", "2dehands.be", "facebook.com"];

export const LEVELS = {
	low: "Faible",
	medium: "Moyen",
	high: "Élevé",
} as const;

const RANGE_MESSAGE = "La date de début doit précéder la date de fin.";

type Filters = {
	q: string | null;
	site: string;
	level: string;
	modelId: string;
	promptVersionId: string;
	from: string;
	to: string;
	withSearch: boolean;
	partial: boolean;
};

function listPath(filters: Filters, before: string | null): string {
	const params = new URLSearchParams();
	if (filters.q !== null) params.set("q", filters.q);
	if (filters.site) params.set("site", filters.site);
	if (filters.level) params.set("level", filters.level);
	if (filters.modelId) params.set("modelId", filters.modelId);
	if (filters.promptVersionId)
		params.set("promptVersionId", filters.promptVersionId);
	if (filters.from) params.set("from", filters.from);
	if (filters.to) params.set("to", filters.to);
	if (filters.withSearch) params.set("withSearch", "true");
	if (filters.partial) params.set("partial", "true");
	// Le curseur est un jeton opaque : repassé tel quel.
	if (before !== null) params.set("before", before);
	const query = params.toString();
	return `/api/admin/analyses${query ? `?${query}` : ""}`;
}

export function Analyses() {
	const session = useSession();
	return session.status === "ready" ? <List api={session.api} /> : null;
}

/** Modèles et versions du prompt des filtres (GET /api/admin/ai) ; `failed` si la lecture échoue. */
function useChoices(api: AdminApi): {
	models: Overview["models"];
	prompts: Overview["prompts"];
	failed: boolean;
} {
	const [state, setState] = useState<{
		models: Overview["models"];
		prompts: Overview["prompts"];
		failed: boolean;
	}>({ models: [], prompts: [], failed: false });

	useEffect(() => {
		let stale = false;
		api
			.get<Overview>("/api/admin/ai")
			.then((overview) => {
				if (!stale)
					setState({
						models: overview.models,
						prompts: overview.prompts,
						failed: false,
					});
			})
			.catch(() => {
				if (!stale) setState({ models: [], prompts: [], failed: true });
			});
		return () => {
			stale = true;
		};
	}, [api]);

	return state;
}

function List({ api }: { api: AdminApi }) {
	const choices = useChoices(api);
	const [input, setInput] = useState("");
	// Terme réellement envoyé : au moins 3 caractères, 300 ms après la dernière frappe.
	const [q, setQ] = useState<string | null>(null);
	const [site, setSite] = useState("");
	const [level, setLevel] = useState("");
	const [modelId, setModelId] = useState("");
	const [promptVersionId, setPromptVersionId] = useState("");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [withSearch, setWithSearch] = useState(false);
	const [partial, setPartial] = useState(false);
	const [items, setItems] = useState<AnalysisList["items"]>([]);
	const [nextBefore, setNextBefore] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	// Change à chaque nouvelle recherche : une page suivante de l'ancienne est ignorée.
	const generation = useRef(0);

	// Les dates sont au format AAAA-MM-JJ : la comparaison de texte suit l'ordre des jours.
	const rangeInvalid = from !== "" && to !== "" && from > to;
	const filters: Filters = {
		q,
		site,
		level,
		modelId,
		promptVersionId,
		from,
		to,
		withSearch,
		partial,
	};

	useEffect(() => {
		const term = input.trim();
		const next = term.length >= SEARCH_MIN ? term : null;
		const timer = setTimeout(() => setQ(next), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [input]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `filters` est reconstruit à chaque rendu ; ses champs sont listés
	useEffect(() => {
		let stale = false;
		generation.current += 1;
		setError(false);
		if (rangeInvalid) {
			// Rien n'est envoyé ; la liste de l'ancienne période ne doit pas rester affichée.
			setItems([]);
			setNextBefore(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		api
			.get<AnalysisList>(listPath(filters, null))
			.then((page) => {
				if (stale) return;
				setItems(page.items);
				setNextBefore(page.nextBefore);
			})
			.catch(() => {
				if (stale) return;
				// Les anciens résultats ne correspondent plus aux filtres, et leur curseur
				// ne doit pas servir avec les nouveaux.
				setItems([]);
				setNextBefore(null);
				setError(true);
			})
			.finally(() => {
				if (!stale) setLoading(false);
			});
		return () => {
			stale = true;
		};
	}, [
		api,
		q,
		site,
		level,
		modelId,
		promptVersionId,
		from,
		to,
		withSearch,
		partial,
		rangeInvalid,
	]);

	async function loadMore() {
		if (nextBefore === null || loading) return;
		const mine = generation.current;
		setLoading(true);
		setError(false);
		try {
			const page = await api.get<AnalysisList>(listPath(filters, nextBefore));
			if (mine !== generation.current) return;
			setItems((current) => [...current, ...page.items]);
			setNextBefore(page.nextBefore);
		} catch {
			if (mine === generation.current) setError(true);
		} finally {
			if (mine === generation.current) setLoading(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-4">
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-search">
						Rechercher dans le titre
					</label>
					<input
						id="analysis-search"
						type="search"
						autoComplete="off"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						className={`${field} block w-72`}
					/>
					<p className="text-xs text-slate-500">3 caractères au moins.</p>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-site">
						Site
					</label>
					<select
						id="analysis-site"
						value={site}
						onChange={(event) => setSite(event.target.value)}
						className={`${field} block`}
					>
						<option value="">Tous</option>
						{SITES.map((domain) => (
							<option key={domain} value={domain}>
								{domain}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-level">
						Niveau
					</label>
					<select
						id="analysis-level"
						value={level}
						onChange={(event) => setLevel(event.target.value)}
						className={`${field} block`}
					>
						<option value="">Tous</option>
						{Object.entries(LEVELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-model">
						Modèle
					</label>
					<select
						id="analysis-model"
						value={modelId}
						onChange={(event) => setModelId(event.target.value)}
						className={`${field} block`}
					>
						<option value="">Tous</option>
						{choices.models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.provider} / {model.slug}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-prompt">
						Version du prompt
					</label>
					<select
						id="analysis-prompt"
						value={promptVersionId}
						onChange={(event) => setPromptVersionId(event.target.value)}
						className={`${field} block`}
					>
						<option value="">Toutes</option>
						{choices.prompts.map((prompt) => (
							<option key={prompt.id} value={prompt.id}>
								v{prompt.version}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-from">
						Du
					</label>
					<input
						id="analysis-from"
						type="date"
						value={from}
						max={to || undefined}
						onChange={(event) => setFrom(event.target.value)}
						aria-invalid={rangeInvalid}
						className={`${field} block`}
					/>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="analysis-to">
						Au
					</label>
					<input
						id="analysis-to"
						type="date"
						value={to}
						min={from || undefined}
						onChange={(event) => setTo(event.target.value)}
						aria-invalid={rangeInvalid}
						className={`${field} block`}
					/>
				</div>
				<label className="flex items-center gap-2 pb-2 text-sm">
					<input
						type="checkbox"
						checked={withSearch}
						onChange={(event) => setWithSearch(event.target.checked)}
					/>
					Avec recherche web
				</label>
				<label className="flex items-center gap-2 pb-2 text-sm">
					<input
						type="checkbox"
						checked={partial}
						onChange={(event) => setPartial(event.target.checked)}
					/>
					Partielle
				</label>
			</div>
			{choices.failed && (
				<p className="text-xs text-red-700">
					Listes des modèles et des versions du prompt indisponibles.
				</p>
			)}

			<div aria-live="polite" className="min-h-5 text-sm">
				{rangeInvalid && <p className="text-red-700">{RANGE_MESSAGE}</p>}
				{error && (
					<p className="text-red-700">Impossible de charger la liste.</p>
				)}
				{loading && <p className="text-slate-500">Chargement…</p>}
			</div>

			{items.length === 0 && !loading && !error && !rangeInvalid ? (
				<p className="text-sm text-slate-500">Aucune analyse.</p>
			) : (
				items.length > 0 && (
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="text-xs text-slate-500">
								<tr>
									<th className="py-2 pr-4 font-medium">Date</th>
									<th className="py-2 pr-4 font-medium">Site</th>
									<th className="py-2 pr-4 font-medium">Titre</th>
									<th className="py-2 pr-4 font-medium">Score</th>
									<th className="py-2 pr-4 font-medium">Pro</th>
									<th className="py-2 pr-4 font-medium">Modèle</th>
									<th className="py-2 pr-4 font-medium">Prompt</th>
									<th className="py-2 pr-4 font-medium">Photos</th>
									<th className="py-2 pr-4 font-medium">Recherches</th>
									<th className="py-2 pr-4 font-medium">Coût</th>
									<th className="py-2 pr-4 font-medium">Appels</th>
									<th className="py-2 font-medium">Servie</th>
								</tr>
							</thead>
							<tbody>
								{items.map((item) => (
									<tr key={item.id} className="border-t border-slate-100">
										<td className="py-2 pr-4 whitespace-nowrap">
											{formatDateTime(item.createdAt)}
										</td>
										<td className="py-2 pr-4">{item.site}</td>
										<td className="py-2 pr-4">
											<Link route={{ name: "analysis", id: item.id }}>
												{item.title}
											</Link>
										</td>
										<td className="py-2 pr-4 whitespace-nowrap">
											{item.score} · {LEVELS[item.level]}
											{item.partial && " · partielle"}
										</td>
										<td className="py-2 pr-4">
											{item.professional ? "oui" : "non"}
										</td>
										<td className="py-2 pr-4">
											{item.model.provider} / {item.model.slug}
										</td>
										<td className="py-2 pr-4">v{item.promptVersion}</td>
										<td className="py-2 pr-4">{item.imagesAnalyzed}</td>
										<td className="py-2 pr-4">{item.webSearches}</td>
										<td className="py-2 pr-4 whitespace-nowrap">
											{formatUsd(item.costUsd, 4)}
										</td>
										<td className="py-2 pr-4">{item.llmCalls}</td>
										<td className="py-2">{item.served}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)
			)}

			{nextBefore !== null && (
				<button
					type="button"
					onClick={() => void loadMore()}
					disabled={loading}
					className={secondaryButton}
				>
					Page suivante
				</button>
			)}
		</div>
	);
}
