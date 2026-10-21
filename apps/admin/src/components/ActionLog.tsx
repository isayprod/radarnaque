import type { components } from "@radarnaque/shared";
import { formatDateTime } from "../format";

type AdminAction = components["schemas"]["AdminActionOut"];

const LABELS: Record<string, string> = {
	"user.plan_set": "Plan attribué",
	"user.role_set": "Rôle modifié",
	"user.deleted": "Compte supprimé",
	"ai.model_added": "Modèle ajouté",
	"ai.model_activated": "Modèle activé",
	"ai.prompt_created": "Prompt créé",
	"ai.prompt_activated": "Prompt activé",
	"ai.settings_set": "Réglage modifié",
	"system.purge": "Purge",
};

function show(value: unknown): string {
	return value === null || value === undefined ? "aucun" : String(value);
}

/** `from → to` (avec le réglage visé pour `ai.settings_set`), ou les repères propres à l'action. */
function formatDetails(details: AdminAction["details"]): string {
	if ("to" in details) {
		const change = `${show(details.from)} → ${show(details.to)}`;
		return typeof details.field === "string"
			? `${details.field} : ${change}`
			: change;
	}
	if (typeof details.slug === "string") {
		return `${show(details.provider)} / ${details.slug}`;
	}
	if (details.version !== undefined) return `version ${show(details.version)}`;
	return "";
}

export function ActionLog({ actions }: { actions: AdminAction[] }) {
	if (actions.length === 0) {
		return <p className="text-sm text-slate-500">Aucune action.</p>;
	}
	return (
		<table className="w-full text-left text-sm">
			<thead className="text-xs text-slate-500">
				<tr>
					<th className="py-1 pr-4 font-medium">Date</th>
					<th className="py-1 pr-4 font-medium">Action</th>
					<th className="py-1 pr-4 font-medium">Admin</th>
					<th className="py-1 font-medium">Détail</th>
				</tr>
			</thead>
			<tbody>
				{actions.map((action) => (
					<tr key={action.id} className="border-t border-slate-100">
						<td className="py-1 pr-4 whitespace-nowrap">
							{formatDateTime(action.createdAt)}
						</td>
						<td className="py-1 pr-4">
							{LABELS[action.action] ?? action.action}
						</td>
						<td className="py-1 pr-4 break-all">
							{action.adminEmail ?? "admin supprimé"}
						</td>
						<td className="py-1">{formatDetails(action.details)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
