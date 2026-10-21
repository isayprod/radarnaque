import type { components } from "@radarnaque/shared";
import { type ReactNode, useEffect, useState } from "react";
import { type AdminApi, ApiFailure } from "../api";
import { ActionLog } from "../components/ActionLog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { formatDateTime } from "../format";
import { hrefOf, isPlainLeftClick, useRoute } from "../router";
import { useSession } from "../session";

type Card = components["schemas"]["AdminUserOut"];

const PLANS = ["trial", "standard", "premium"] as const;

const SCAN_KINDS: Record<string, string> = {
	full: "Complète",
	text: "Texte",
	image: "Image",
};

const secondaryButton =
	"rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
const dangerButton =
	"rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-60";

/** Texte clair d'une erreur d'action. Les 409 se distinguent par le message de l'API. */
function actionMessage(error: unknown): string {
	if (error instanceof ApiFailure) {
		if (error.status === 404) return "Compte introuvable.";
		if (error.status === 409) {
			if (error.message.includes("dernier admin")) {
				return "Impossible : c'est le dernier admin.";
			}
			if (error.message.includes("propre")) {
				return "Impossible sur votre propre compte.";
			}
			return error.message === error.code
				? "Impossible : l'action entre en conflit avec l'état du compte."
				: error.message;
		}
	}
	return "L'action a échoué, réessayez.";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title} className="space-y-2">
			<h2 className="text-base font-semibold">{title}</h2>
			{children}
		</section>
	);
}

function Term({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex gap-2">
			<dt className="w-40 shrink-0 text-slate-500">{label}</dt>
			<dd className="min-w-0 break-all">{children}</dd>
		</div>
	);
}

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
	const [plan, setPlan] = useState<string>("standard");

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

	const backTarget = { name: "users" } as const;
	const back = (
		<a
			href={hrefOf(backTarget)}
			onClick={(event) => {
				if (!isPlainLeftClick(event)) return;
				event.preventDefault();
				navigate(backTarget);
			}}
			className="text-sm font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
		>
			← Retour à la liste
		</a>
	);

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
						disabled={stripe}
						onChange={(event) => setPlan(event.target.value)}
						className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-60"
					>
						{PLANS.map((code) => (
							<option key={code} value={code}>
								{code}
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={stripe}
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
