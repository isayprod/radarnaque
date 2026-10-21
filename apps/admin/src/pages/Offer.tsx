import type { components } from "@radarnaque/shared";
import { type FormEvent, useEffect, useState } from "react";
import type { AdminApi } from "../api";
import { ActionLog } from "../components/ActionLog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
	actionMessage,
	ErrorLine,
	field,
	primaryButton,
	Section,
	Term,
} from "../components/ui";
import { formatEuros } from "../format";
import { useSession } from "../session";

type AdminOffer = components["schemas"]["AdminOfferOut"];
type Plan = components["schemas"]["OfferPlanOut"];
type PlanChanges = components["schemas"]["OfferPlanIn"];
type Interval = "month" | "year";
type TextField = "month" | "year" | "quota" | "totalScanCap" | "maxImages";

const TRIAL = "trial";
const INTERVALS: Record<Interval, { label: string; stripe: string }> = {
	month: { label: "Prix mensuel", stripe: "Identifiant Stripe, prix mensuel" },
	year: { label: "Prix annuel", stripe: "Identifiant Stripe, prix annuel" },
};
const PLAN_LABELS: Record<string, string> = {
	trial: "Essai",
	standard: "Standard",
	premium: "Premium",
};
const PERIODS: Record<string, string> = {
	lifetime: "Total, à vie",
	subscription_month: "Par mois d'abonnement",
};

// Bornes de l'API (en centimes pour les prix).
const MAX_PRICE_CENTS = 100_000;
const MAX_QUOTA = 100_000;
const MAX_CAP = 100_000;
const MAX_IMAGES = 4;

const STRIPE_WARNING = "Créez aussi le nouveau prix dans Stripe.";
const PRIVACY_WARNING =
	"Pensez à mettre à jour la page /privacy, qui annonce 1 photo en Standard et jusqu'à 4 en Premium et pendant l'essai.";

const planLabel = (code: string) => PLAN_LABELS[code] ?? code;

/** Un prix saisi en euros (« 2,99 » ou « 2.99 », deux décimales au plus) en centimes entiers,
 * sans passer par un calcul flottant (1,15 × 100 donnerait 114,99…) ; `null` si invalide. */
function parseEuros(raw: string): number | null {
	const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(raw.trim());
	if (match === null) return null;
	const cents =
		Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
	return cents <= MAX_PRICE_CENTS ? cents : null;
}

function parseCount(raw: string, max: number): number | null {
	const text = raw.trim();
	if (!/^\d{1,7}$/.test(text)) return null;
	const value = Number(text);
	return value <= max ? value : null;
}

/** Des centimes tels qu'on les saisit : « 2,99 ». */
function euroDraft(cents: number): string {
	return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}

type Drafts = {
	month: string;
	year: string;
	quota: string;
	totalScanCap: string;
	maxImages: string;
	cardIcons: boolean;
};

function draftsOf(plan: Plan): Drafts {
	const price = (interval: Interval) => {
		const cents = plan.prices[interval]?.amountCents;
		return cents === undefined ? "" : euroDraft(cents);
	};
	return {
		month: price("month"),
		year: price("year"),
		quota: String(plan.quota),
		totalScanCap: plan.totalScanCap === null ? "" : String(plan.totalScanCap),
		maxImages: String(plan.maxImages),
		cardIcons: plan.cardIcons,
	};
}

export function Offer() {
	const session = useSession();
	return session.status === "ready" ? <OfferView api={session.api} /> : null;
}

function OfferView({ api }: { api: AdminApi }) {
	const [offer, setOffer] = useState<AdminOffer | null>(null);
	const [loadError, setLoadError] = useState(false);

	useEffect(() => {
		let stale = false;
		setLoadError(false);
		api
			.get<AdminOffer>("/api/admin/offer")
			.then((loaded) => {
				if (!stale) setOffer(loaded);
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
			<p className="text-sm text-red-700">Impossible de charger l'offre.</p>
		);
	}
	if (offer === null) {
		return <p className="text-sm text-slate-500">Chargement…</p>;
	}

	return (
		<div className="space-y-8">
			{offer.plans.map((plan) => (
				<PlanForm key={plan.code} api={api} plan={plan} onOffer={setOffer} />
			))}
			<Section title="Historique">
				<p className="text-xs text-slate-500">
					20 dernières modifications de l'offre.
				</p>
				<ActionLog actions={offer.actions} />
			</Section>
		</div>
	);
}

function PlanForm({
	api,
	plan,
	onOffer,
}: {
	api: AdminApi;
	plan: Plan;
	onOffer: (offer: AdminOffer) => void;
}) {
	const [drafts, setDrafts] = useState(() => draftsOf(plan));
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const label = planLabel(plan.code);
	const priced = plan.code !== TRIAL;

	const set = <K extends keyof Drafts>(key: K, value: Drafts[K]) =>
		setDrafts({ ...drafts, [key]: value });

	// Pour chaque champ : valide ou non, et s'il a changé, une ligne « avant → après » pour la
	// confirmation et sa part du corps envoyé (seuls les champs modifiés partent).
	const changes: string[] = [];
	const body: PlanChanges = {};
	const checks: Record<string, boolean> = {};
	const stripe: string[] = [];

	if (priced) {
		for (const interval of ["month", "year"] as const) {
			const current = plan.prices[interval];
			const raw = drafts[interval];
			// Sans prix enregistré, un champ vide reste vide ; avec un prix, on ne peut pas l'effacer.
			if (current === undefined && raw.trim() === "") {
				checks[interval] = true;
				continue;
			}
			const cents = parseEuros(raw);
			checks[interval] = cents !== null;
			if (cents === null || cents === current?.amountCents) continue;
			changes.push(
				`${INTERVALS[interval].label} ${label} : ${
					current === undefined ? "aucun" : formatEuros(current.amountCents)
				} → ${formatEuros(cents)}`,
			);
			body.prices = { ...body.prices, [interval]: cents };
			if (current?.stripePriceId) stripe.push(interval);
		}
	}
	const quota = parseCount(drafts.quota, MAX_QUOTA);
	checks.quota = quota !== null;
	if (quota !== null && quota !== plan.quota) {
		changes.push(`Quota ${label} : ${plan.quota} → ${quota}`);
		body.quota = quota;
	}
	if (drafts.cardIcons !== plan.cardIcons) {
		changes.push(
			`Icônes sur les cartes ${label} : ${plan.cardIcons ? "oui" : "non"} → ${drafts.cardIcons ? "oui" : "non"}`,
		);
		body.cardIcons = drafts.cardIcons;
	}
	const images = parseCount(drafts.maxImages, MAX_IMAGES);
	checks.maxImages = images !== null;
	if (images !== null && images !== plan.maxImages) {
		changes.push(`Photos par analyse ${label} : ${plan.maxImages} → ${images}`);
		body.maxImages = images;
	}
	// Vide = aucun plafond : le seul champ envoyé avec `null`.
	const capEmpty = drafts.totalScanCap.trim() === "";
	const cap = capEmpty ? null : parseCount(drafts.totalScanCap, MAX_CAP);
	checks.totalScanCap = capEmpty || cap !== null;
	if (checks.totalScanCap && cap !== plan.totalScanCap) {
		changes.push(
			`Plafond total ${label} : ${plan.totalScanCap ?? "aucun"} → ${cap ?? "aucun"}`,
		);
		body.totalScanCap = cap;
	}

	const allValid = Object.values(checks).every(Boolean);
	const canSave = allValid && changes.length > 0;

	function review(event: FormEvent) {
		event.preventDefault();
		if (canSave) setConfirming(true);
	}

	// Ne rejette jamais : `ConfirmDialog` ne rattrape pas les erreurs.
	async function save() {
		setError(null);
		try {
			const next = await api.send<AdminOffer>(
				"PATCH",
				`/api/admin/offer/plans/${plan.code}`,
				body,
			);
			const fresh = next.plans.find((p) => p.code === plan.code);
			onOffer(next);
			// L'offre renvoyée fait foi : les brouillons de ce plan la reprennent.
			if (fresh) setDrafts(draftsOf(fresh));
		} catch (failure) {
			setError(actionMessage(failure));
		} finally {
			setConfirming(false);
		}
	}

	const warnings = [
		...(stripe.length > 0 ? [STRIPE_WARNING] : []),
		...(images !== null && images !== plan.maxImages ? [PRIVACY_WARNING] : []),
	];
	const message = [`${changes.join(" ; ")}.`, ...warnings].join(" ");

	const id = (name: string) => `plan-${plan.code}-${name}`;
	const input = (
		name: TextField,
		text: string,
		hint: string,
		mode: "numeric" | "decimal" = "numeric",
	) => (
		<div className="space-y-1">
			<label className="text-sm font-medium" htmlFor={id(name)}>
				{text}
			</label>
			<input
				id={id(name)}
				type="text"
				inputMode={mode}
				autoComplete="off"
				value={drafts[name]}
				aria-invalid={!checks[name]}
				aria-describedby={`${id(name)}-hint`}
				onChange={(event) => set(name, event.target.value)}
				className={`${field} block w-40 aria-invalid:border-red-500`}
			/>
			<p
				id={`${id(name)}-hint`}
				className={`text-xs ${checks[name] ? "text-slate-500" : "text-red-700"}`}
			>
				{hint}
			</p>
		</div>
	);

	return (
		<Section title={`Plan ${label}`}>
			<form onSubmit={review} noValidate className="space-y-3">
				<div className="flex flex-wrap items-start gap-4">
					{priced &&
						input(
							"month",
							"Prix mensuel (€)",
							"En euros, de 0 à 1000.",
							"decimal",
						)}
					{priced &&
						input(
							"year",
							"Prix annuel (€)",
							"En euros, de 0 à 1000.",
							"decimal",
						)}
					{input("quota", "Quota", `Scans par période, de 0 à ${MAX_QUOTA}.`)}
					{input(
						"totalScanCap",
						"Plafond total",
						`De 0 à ${MAX_CAP} ; vide : aucun plafond.`,
					)}
					{input("maxImages", "Photos par analyse", `De 0 à ${MAX_IMAGES}.`)}
					<div className="flex items-center gap-2 pt-6">
						<input
							id={id("cardIcons")}
							type="checkbox"
							checked={drafts.cardIcons}
							onChange={(event) => set("cardIcons", event.target.checked)}
						/>
						<label className="text-sm font-medium" htmlFor={id("cardIcons")}>
							Icônes sur les cartes
						</label>
					</div>
				</div>
				<dl className="space-y-1 text-sm">
					<Term label="Période">
						{PERIODS[plan.quotaPeriod] ?? plan.quotaPeriod}
					</Term>
					{priced &&
						(["month", "year"] as const).map((interval) => (
							<Term key={interval} label={INTERVALS[interval].stripe}>
								{plan.prices[interval]?.stripePriceId ?? "—"}
							</Term>
						))}
				</dl>
				<button type="submit" disabled={!canSave} className={primaryButton}>
					Enregistrer
				</button>
			</form>
			<ErrorLine message={error} />

			{confirming && (
				<ConfirmDialog
					title={`Modifier le plan ${label}`}
					message={message}
					confirmLabel="Enregistrer"
					onCancel={() => setConfirming(false)}
					onConfirm={save}
				/>
			)}
		</Section>
	);
}
