import { useCallback, useEffect, useState } from "react";
import type { AdminApi } from "../api";
import { ActionLog } from "../components/ActionLog";
import { Section } from "../components/ui";
import { useSession } from "../session";
import { Models } from "./ai/Models";
import { Prompts } from "./ai/Prompts";
import { Search } from "./ai/Search";
import { Settings } from "./ai/Settings";
import type { Overview } from "./ai/shared";

const KEY_STATES = {
	present: "Clé présente",
	absent: "Clé absente",
	not_required: "Pas de clé requise",
} as const;

/** `promptId` : la version de prompt à ouvrir en consultation (route /admin/ia/prompts/{id}). */
export function Ai({ promptId }: { promptId?: number }) {
	const session = useSession();
	return session.status === "ready" ? (
		<AiView api={session.api} promptId={promptId} />
	) : null;
}

function AiView({ api, promptId }: { api: AdminApi; promptId?: number }) {
	const [overview, setOverview] = useState<Overview | null>(null);
	const [loadError, setLoadError] = useState(false);

	// Recharge la vue d'ensemble ; l'erreur est laissée à l'appelant (création d'un prompt).
	const reload = useCallback(async () => {
		setOverview(await api.get<Overview>("/api/admin/ai"));
	}, [api]);

	useEffect(() => {
		let stale = false;
		setLoadError(false);
		api
			.get<Overview>("/api/admin/ai")
			.then((loaded) => {
				if (!stale) setOverview(loaded);
			})
			.catch(() => {
				if (!stale) setLoadError(true);
			});
		return () => {
			stale = true;
		};
	}, [api]);

	if (loadError) {
		return (
			<p className="text-sm text-red-700">Impossible de charger l'écran IA.</p>
		);
	}
	if (overview === null) {
		return <p className="text-sm text-slate-500">Chargement…</p>;
	}

	return (
		<div className="space-y-8">
			<Section title="Fournisseurs">
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-xs text-slate-500">
							<tr>
								<th className="py-1 pr-4 font-medium">Fournisseur</th>
								<th className="py-1 pr-4 font-medium">API</th>
								<th className="py-1 pr-4 font-medium">Sortie</th>
								<th className="py-1 pr-4 font-medium">Raisonnement</th>
								<th className="py-1 pr-4 font-medium">Images max.</th>
								<th className="py-1 font-medium">Clé</th>
							</tr>
						</thead>
						<tbody>
							{overview.providers.map((provider) => (
								<tr key={provider.code} className="border-t border-slate-100">
									<td className="py-1 pr-4 font-medium">{provider.code}</td>
									<td className="py-1 pr-4">{provider.api}</td>
									<td className="py-1 pr-4">{provider.structuredOutput}</td>
									<td className="py-1 pr-4">
										{provider.reasoningEffort ?? "—"}
									</td>
									<td className="py-1 pr-4">{provider.maxImages ?? "—"}</td>
									<td className="py-1">{KEY_STATES[provider.key]}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Section>

			<Models api={api} overview={overview} onOverview={setOverview} />
			<Prompts
				api={api}
				overview={overview}
				onOverview={setOverview}
				reload={reload}
				promptId={promptId}
			/>
			<Settings
				api={api}
				settings={overview.settings}
				onOverview={setOverview}
			/>
			<Search api={api} search={overview.search} />

			<Section title="Journal">
				<p className="text-xs text-slate-500">20 dernières actions IA.</p>
				<ActionLog actions={overview.actions} />
			</Section>
		</div>
	);
}
