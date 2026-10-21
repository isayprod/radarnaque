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
	"offer.price_set": "Prix modifié",
	"offer.quota_set": "Quota modifié",
	"offer.feature_set": "Fonctionnalité modifiée",
	"offer.max_images_set": "Photos modifiées",
	"offer.total_cap_set": "Plafond total modifié",
	"system.purge": "Purge",
};

const INTERVALS: Record<string, string> = { month: "mois", year: "an" };
const FEATURES: Record<string, string> = { card_icons: "icônes des cartes" };

const euros = new Intl.NumberFormat("fr-BE", {
	style: "currency",
	currency: "EUR",
});

function show(value: unknown): string {
	if (value === null || value === undefined) return "aucun";
	if (typeof value === "boolean") return value ? "oui" : "non";
	return String(value);
}

// Un prix de l'offre est en centimes ; le journal l'affiche en euros.
function showPrice(value: unknown): string {
	return typeof value === "number" ? euros.format(value / 100) : show(value);
}

/** Le plan visé par une action de l'offre, avec l'intervalle ou la fonctionnalité s'il y en a un. */
function offerTarget(details: AdminAction["details"]): string {
	const scope =
		typeof details.interval === "string"
			? (INTERVALS[details.interval] ?? details.interval)
			: typeof details.feature === "string"
				? (FEATURES[details.feature] ?? details.feature)
				: null;
	return scope === null
		? show(details.plan)
		: `${show(details.plan)}, ${scope}`;
}

/** `from → to` (avec le réglage visé pour `ai.settings_set`, le plan pour l'offre), ou les repères propres à l'action. */
function formatDetails(action: AdminAction): string {
	const { details } = action;
	if (action.action.startsWith("offer.") && "to" in details) {
		const price = action.action === "offer.price_set" ? showPrice : show;
		return `${offerTarget(details)} : ${price(details.from)} → ${price(details.to)}`;
	}
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
						<td className="py-1">{formatDetails(action)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
