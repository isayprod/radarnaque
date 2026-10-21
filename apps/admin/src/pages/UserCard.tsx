import type { components } from "@radarnaque/shared";
import { useEffect, useState } from "react";
import { type AdminApi, ApiFailure } from "../api";
import { ActionLog } from "../components/ActionLog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Link } from "../components/Link";
import {
	actionMessage,
	dangerButton,
	Section,
	secondaryButton,
	Term,
} from "../components/ui";
import { formatDateTime } from "../format";
import { usePlans } from "../plans";
import { useRoute } from "../router";
import { useSession } from "../session";

type Card = components["schemas"]["AdminUserOut"];

const SCAN_KINDS: Record<string, string> = {
	full: "Complète",
	text: "Texte",
	image: "Image",
};

export function UserCard({ id }: { id: string }) {
	const session = useSession();
	return session.status === "ready" ? (
		<CardView api={session.api} ownEmail={session.email} id={id} />
	) : null;
}

type Dialog = "plan" | "role" | "delete";

function CardView({
	api,
	ownEmail,
	id,
}: {
	api: AdminApi;
	ownEmail: string;
	id: string;
}) {
	const [, navigate] = useRoute();
	const [card, setCard] = useState<Card | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const plans = usePlans();
	// Le plan choisi dans le menu ; sans choix, « standard » s'il existe, sinon le premier.
	const [choice, setChoice] = useState<string | null>(null);

	useEffect(() => {
		let stale = false;
		setCard(null);
		setLoadError(null);
		setActionError(null);
		api
			.get<Card>(`/api/admin/users/${encodeURIComponent(id)}`)
			.then((loaded) => {
				if (!stale) setCard(loaded);
			})
			.catch((error: unknown) => {
				if (stale) return;
				setLoadError(
					error instanceof ApiFailure && error.status === 404
						? "Compte introuvable."
						: "Impossible de charger la fiche.",
				);
			});
		return () => {
			stale = true;
		};
	}, [api, id]);

	const back = <Link route={{ name: "users" }}>← Retour à la liste</Link>;

	if (loadError !== null) {
		return (
			<div className="space-y-4">
				{back}
				<p className="text-sm text-red-700">{loadError}</p>
			</div>
		);
	}
	if (card === null)
		return <p className="text-sm text-slate-500">Chargement…</p>;

	const plan =
		choice !== null && plans?.includes(choice)
			? choice
			: plans?.includes("standard")
				? "standard"
				: (plans?.[0] ?? "");
	const isOwn = card.email.toLowerCase() === ownEmail.toLowerCase();
	const stripe = card.subscription?.provider === "stripe";
	const base = `/api/admin/users/${encodeURIComponent(card.id)}`;

	// Chaque action : requête, puis la boîte se ferme (succès ou erreur affichée dans la fiche).
	async function run(request: () => Promise<void>) {
		setActionError(null);
		try {
			await request();
		} catch (error) {
			setActionError(actionMessage(error));
		} finally {
			setDialog(null);
		}
	}

	const newRole = card.role === "admin" ? "user" : "admin";
	const roleLabel =
		card.role === "admin" ? "Retirer le rôle admin" : "Nommer admin";

	return (
		<div className="space-y-6">
			{back}

			<Section title="Identité">
				<dl className="space-y-1 text-sm">
					<Term label="Email">{card.email}</Term>
					<Term label="Identifiant">{card.id}</Term>
					<Term label="Créé le">{formatDateTime(card.createdAt)}</Term>
					<Term label="Email vérifié">
						{card.emailVerified ? "oui" : "non"}
					</Term>
					<Term label="Rôle">{card.role}</Term>
				</dl>
			</Section>

			<Section title="Abonnement actif">
				{card.subscription === null ? (
					<p className="text-sm text-slate-500">Aucun abonnement actif.</p>
				) : (
					<dl className="space-y-1 text-sm">
						<Term label="Plan">{card.subscription.plan}</Term>
						<Term label="Statut">{card.subscription.status}</Term>
						<Term label="Fournisseur">{card.subscription.provider}</Term>
						<Term label="Début de période">
							{formatDateTime(card.subscription.periodStart)}
						</Term>
						<Term label="Fin">
							{formatDateTime(card.subscription.periodEnd)}
						</Term>
					</dl>
				)}
				{card.usage !== null && (
					<ul className="space-y-1 text-sm">
						{card.usage.quotas.map((quota) => (
							<li key={quota.scanKind}>
								{SCAN_KINDS[quota.scanKind ?? ""] ?? quota.scanKind} :{" "}
								{quota.used} utilisées, {quota.remaining} restantes (sur{" "}
								{quota.limit})
							</li>
						))}
						{card.usage.totalCap !== null && (
							<li>
								Total : {card.usage.totalCap.used} utilisées,{" "}
								{card.usage.totalCap.remaining} restantes (sur{" "}
								{card.usage.totalCap.limit})
							</li>
						)}
						{card.usage.purgedScans > 0 && (
							<li>
								{card.usage.purgedScans} analyses effacées par la purge,
								comptées dans le quota.
							</li>
						)}
					</ul>
				)}
			</Section>

			<Section title="Historique des abonnements">
				<table className="w-full text-left text-sm">
					<thead className="text-xs text-slate-500">
						<tr>
							<th className="py-1 pr-4 font-medium">Plan</th>
							<th className="py-1 pr-4 font-medium">Statut</th>
							<th className="py-1 pr-4 font-medium">Fournisseur</th>
							<th className="py-1 pr-4 font-medium">Début</th>
							<th className="py-1 font-medium">Fin</th>
						</tr>
					</thead>
					<tbody>
						{card.subscriptions.map((sub) => (
							<tr key={sub.id} className="border-t border-slate-100">
								<td className="py-1 pr-4">{sub.plan}</td>
								<td className="py-1 pr-4">{sub.status}</td>
								<td className="py-1 pr-4">{sub.provider}</td>
								<td className="py-1 pr-4 whitespace-nowrap">
									{formatDateTime(sub.periodStart)}
								</td>
								<td className="py-1 whitespace-nowrap">
									{formatDateTime(sub.periodEnd)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</Section>

			<Section title="Activité">
				{card.scans.length === 0 ? (
					<p className="text-sm text-slate-500">Aucune analyse.</p>
				) : (
					<table className="w-full text-left text-sm">
						<thead className="text-xs text-slate-500">
							<tr>
								<th className="py-1 pr-4 font-medium">Date</th>
								<th className="py-1 pr-4 font-medium">Site</th>
								<th className="py-1 pr-4 font-medium">Titre</th>
								<th className="py-1 pr-4 font-medium">Score</th>
								<th className="py-1 font-medium">État</th>
							</tr>
						</thead>
						<tbody>
							{card.scans.map((scan) => (
								<tr
									key={scan.scanEventId}
									className="border-t border-slate-100"
								>
									<td className="py-1 pr-4 whitespace-nowrap">
										{formatDateTime(scan.createdAt)}
									</td>
									<td className="py-1 pr-4 break-all">{scan.site ?? "—"}</td>
									<td className="py-1 pr-4">{scan.title ?? "—"}</td>
									<td className="py-1 pr-4">{scan.score ?? "—"}</td>
									<td className="py-1">
										{scan.failed ? "échec" : scan.fromCache ? "cache" : "—"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Section>

			<Section title="Journal">
				<ActionLog actions={card.actions} />
			</Section>

			<Section title="Actions">
				<div className="flex flex-wrap items-center gap-3">
					<label className="text-sm font-medium" htmlFor="plan-choice">
						Plan à attribuer
					</label>
					<select
						id="plan-choice"
						value={plan}
						disabled={stripe || plans === null}
						onChange={(event) => setChoice(event.target.value)}
						className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
					>
						{(plans ?? []).map((code) => (
							<option key={code} value={code}>
								{code}
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={stripe || plans === null}
						onClick={() => setDialog("plan")}
						className={secondaryButton}
					>
						Attribuer un plan
					</button>
					{stripe && (
						<span className="text-sm text-slate-500">Géré dans Stripe</span>
					)}
				</div>
				{!isOwn && (
					<div className="flex flex-wrap gap-3">
						{(card.role === "user" || card.role === "admin") && (
							<button
								type="button"
								onClick={() => setDialog("role")}
								className={secondaryButton}
							>
								{roleLabel}
							</button>
						)}
						<button
							type="button"
							onClick={() => setDialog("delete")}
							className={dangerButton}
						>
							Supprimer le compte
						</button>
					</div>
				)}
				<div aria-live="polite" className="min-h-5 text-sm">
					{actionError && (
						<p role="alert" className="text-red-700">
							{actionError}
						</p>
					)}
				</div>
			</Section>

			{dialog === "plan" && (
				<ConfirmDialog
					title="Attribuer un plan"
					message={`Plan actuel : ${card.subscription?.plan ?? "aucun"}. Le nouveau plan commence maintenant.`}
					confirmLabel="Attribuer"
					onCancel={() => setDialog(null)}
					onConfirm={() =>
						run(async () => {
							setCard(await api.send<Card>("POST", `${base}/plan`, { plan }));
						})
					}
				/>
			)}
			{dialog === "role" && (
				<ConfirmDialog
					title={roleLabel}
					message={
						card.role === "admin"
							? `${card.email} ne pourra plus accéder à l'administration.`
							: `${card.email} aura accès à toute l'administration.`
					}
					confirmLabel={
						card.role === "admin" ? "Retirer le rôle" : "Nommer admin"
					}
					onCancel={() => setDialog(null)}
					onConfirm={() =>
						run(async () => {
							setCard(
								await api.send<Card>("POST", `${base}/role`, { role: newRole }),
							);
						})
					}
				/>
			)}
			{dialog === "delete" && (
				<ConfirmDialog
					title="Supprimer le compte"
					message="Le compte et toutes ses données seront supprimés définitivement."
					confirmLabel="Supprimer"
					typedConfirmation={card.email}
					onCancel={() => setDialog(null)}
					onConfirm={() =>
						run(async () => {
							await api.send<void>("DELETE", base);
							navigate({ name: "users" });
						})
					}
				/>
			)}
		</div>
	);
}
