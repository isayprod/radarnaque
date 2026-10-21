import type { components } from "@radarnaque/shared";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { AdminApi } from "../api";
import { DailyChart } from "../components/DailyChart";
import {
	primaryButton,
	Section,
	secondaryButton,
	Term,
} from "../components/ui";
import { formatDateTime, formatUsd } from "../format";
import { useSession } from "../session";

type Schemas = components["schemas"];
type DashboardData = Schemas["DashboardOut"];
type DailyData = Schemas["DailyOut"];
type Stats = Schemas["DashboardStatsOut"];

type Loaded = { dashboard: DashboardData; daily: DailyData };

const SEARCH_STATES: Record<
	DashboardData["health"]["search"]["status"],
	{ label: string; tone: string }
> = {
	ok: { label: "Recherche disponible", tone: "text-green-700" },
	down: { label: "Recherche indisponible", tone: "text-orange-700" },
	disabled: { label: "Recherche désactivée", tone: "text-slate-500" },
};

const count = (value: number) => value.toLocaleString("fr-BE");

/** Pourcentage arrondi à l'entier (l'API envoie la valeur brute) ; « — » sans valeur. */
function percent(value: number | null): string {
	return value === null ? "—" : `${Math.round(value)} %`;
}

/** Moyenne à une décimale ; « — » sans valeur. */
function average(value: number | null): string {
	return value === null
		? "—"
		: value.toLocaleString("fr-BE", { maximumFractionDigits: 1 });
}

export function Dashboard() {
	const session = useSession();
	return session.status === "ready" ? (
		<DashboardView api={session.api} />
	) : null;
}

function DashboardView({ api }: { api: AdminApi }) {
	const [data, setData] = useState<Loaded | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	// Seule la dernière demande compte (clic rapide, démontage).
	const latest = useRef(0);

	const load = useCallback(() => {
		const request = ++latest.current;
		setLoading(true);
		setFailed(false);
		Promise.all([
			api.get<DashboardData>("/api/admin/dashboard"),
			api.get<DailyData>("/api/admin/dashboard/daily?days=30"),
		])
			.then(([dashboard, daily]) => {
				if (request !== latest.current) return;
				setData({ dashboard, daily });
				setLoading(false);
			})
			.catch(() => {
				if (request !== latest.current) return;
				setData(null);
				setFailed(true);
				setLoading(false);
			});
	}, [api]);

	useEffect(() => {
		load();
		return () => {
			latest.current++;
		};
	}, [load]);

	if (failed) {
		return (
			<div className="space-y-3">
				<p role="alert" className="text-sm text-red-700">
					Impossible de charger le tableau de bord.
				</p>
				<button type="button" onClick={load} className={primaryButton}>
					Réessayer
				</button>
			</div>
		);
	}
	if (data === null) {
		return <p className="text-sm text-slate-500">Chargement…</p>;
	}

	const { dashboard, daily } = data;
	const { today, last7Days } = dashboard;

	return (
		<div className="space-y-8">
			<div>
				<button
					type="button"
					onClick={load}
					disabled={loading}
					className={secondaryButton}
				>
					Actualiser
				</button>
			</div>

			<Section title="Activité">
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					<Card
						title="Analyses"
						today={count(today.scans)}
						week={count(last7Days.scans)}
					/>
					<Card
						title="Appels au modèle"
						today={count(today.llmCalls)}
						week={count(last7Days.llmCalls)}
					/>
					<Card
						title="Servies depuis le cache"
						today={percent(today.fromCachePct)}
						week={percent(last7Days.fromCachePct)}
					/>
					<Card
						title="Échecs"
						today={percent(today.failedPct)}
						week={percent(last7Days.failedPct)}
						todayNote={codes(today)}
						weekNote={codes(last7Days)}
					/>
					<Card
						title="Coût IA"
						today={formatUsd(today.costUsd)}
						week={formatUsd(last7Days.costUsd)}
					/>
					<Card
						title="Coût moyen par appel"
						today={formatUsd(today.avgCostUsd, 4)}
						week={formatUsd(last7Days.avgCostUsd, 4)}
					/>
					<Card
						title="Recherches web"
						today={count(today.webSearches)}
						week={count(last7Days.webSearches)}
						todayNote={perCall(today)}
						weekNote={perCall(last7Days)}
					/>
				</div>
			</Section>

			<Section title="30 derniers jours">
				<DailyChart points={daily.points} />
			</Section>

			<div className="grid gap-8 lg:grid-cols-3">
				<Section title="Abonnés actifs">
					<dl className="space-y-1 text-sm">
						<Term label="Essai">{count(dashboard.subscribers.trial)}</Term>
						<Term label="Standard">
							{count(dashboard.subscribers.standard)}
						</Term>
						<Term label="Premium">{count(dashboard.subscribers.premium)}</Term>
						<Term label="Nouveaux comptes (7 jours)">
							{count(dashboard.subscribers.newAccounts7Days)}
						</Term>
					</dl>
				</Section>

				<Section title="Mois en cours">
					<dl className="space-y-1 text-sm">
						<Term label="Coût IA">{formatUsd(dashboard.month.costUsd)}</Term>
						<Term label="Projection">
							{formatUsd(dashboard.month.projectedUsd)}
						</Term>
					</dl>
				</Section>

				<Section title="Santé du service">
					<Health health={dashboard.health} />
				</Section>
			</div>
		</div>
	);
}

/** Les trois codes d'échec les plus fréquents de la période, ou rien. */
function codes(stats: Stats): string | null {
	return stats.topFailures.length === 0
		? null
		: stats.topFailures.map((f) => `${f.code} : ${f.count}`).join(", ");
}

function perCall(stats: Stats): string {
	return `${average(stats.avgWebSearches)} par appel`;
}

function Card({
	title,
	today,
	week,
	todayNote = null,
	weekNote = null,
}: {
	title: string;
	today: string;
	week: string;
	todayNote?: string | null;
	weekNote?: string | null;
}) {
	return (
		<section
			aria-label={title}
			className="rounded-lg border border-slate-200 p-4"
		>
			<h3 className="text-sm font-medium text-slate-500">{title}</h3>
			<dl className="mt-2 space-y-2">
				<Figure label="Aujourd'hui" value={today} note={todayNote} />
				<Figure label="7 jours" value={week} note={weekNote} />
			</dl>
		</section>
	);
}

function Figure({
	label,
	value,
	note,
}: {
	label: string;
	value: string;
	note: string | null;
}) {
	// `dd` ne contient que la valeur quand il n'y a pas de note.
	const content: ReactNode = note ? (
		<>
			<span>{value}</span>
			<span className="block text-xs font-normal text-slate-500">{note}</span>
		</>
	) : (
		value
	);
	return (
		<div className="flex items-baseline justify-between gap-3">
			<dt className="text-xs text-slate-500">{label}</dt>
			<dd className="text-right text-lg font-semibold">{content}</dd>
		</div>
	);
}

function Health({ health }: { health: DashboardData["health"] }) {
	const search = SEARCH_STATES[health.search.status];
	const purge = health.lastPurge;
	return (
		<dl className="space-y-1 text-sm">
			<Term label="Modèle actif">
				{health.activeModel
					? `${health.activeModel.provider} / ${health.activeModel.slug}`
					: "Aucun modèle actif"}
			</Term>
			<Term label="Moteur de recherche">
				<span className={search.tone}>{search.label}</span>
			</Term>
			<Term label="Dernière purge">
				{purge
					? `${formatDateTime(purge.at)} : ${purge.deletedScans} événement${purge.deletedScans > 1 ? "s" : ""} supprimé${purge.deletedScans > 1 ? "s" : ""}`
					: "Aucune purge"}
			</Term>
		</dl>
	);
}
