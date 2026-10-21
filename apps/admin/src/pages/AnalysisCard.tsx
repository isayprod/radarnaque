import type { components } from "@radarnaque/shared";
import { useEffect, useState } from "react";
import { type AdminApi, ApiFailure } from "../api";
import { Link } from "../components/Link";
import { Section, Term } from "../components/ui";
import { formatDateTime, formatUsd } from "../format";
import { useSession } from "../session";
import { LEVELS } from "./Analyses";

type Detail = components["schemas"]["AnalysisDetailOut"];

export function AnalysisCard({ id }: { id: number }) {
	const session = useSession();
	return session.status === "ready" ? (
		<CardView api={session.api} id={id} />
	) : null;
}

/** Le lien vers l'annonce n'existe que pour une adresse http(s) : le snapshot vient d'une page
 * tierce, jamais un `javascript:` ou autre schéma. */
function isWebUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}

/** Prix du snapshot : en devise s'il y en a une ; sinon le nombre seul, sans en deviner l'unité. */
function formatPrice(cents: number, currency: string | null): string {
	const amount = cents / 100;
	if (currency !== null) {
		try {
			return new Intl.NumberFormat("fr-BE", {
				style: "currency",
				currency,
			}).format(amount);
		} catch {
			// Code de devise inconnu : repli sur le nombre et le code.
			return `${amount.toLocaleString("fr-BE", { minimumFractionDigits: 2 })} ${currency}`;
		}
	}
	return amount.toLocaleString("fr-BE", { minimumFractionDigits: 2 });
}

function CardView({ api, id }: { api: AdminApi; id: number }) {
	const [detail, setDetail] = useState<Detail | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let stale = false;
		setDetail(null);
		setLoadError(null);
		api
			.get<Detail>(`/api/admin/analyses/${id}`)
			.then((loaded) => {
				if (!stale) setDetail(loaded);
			})
			.catch((error: unknown) => {
				if (stale) return;
				setLoadError(
					error instanceof ApiFailure && error.status === 404
						? "Analyse introuvable."
						: "Impossible de charger l'analyse.",
				);
			});
		return () => {
			stale = true;
		};
	}, [api, id]);

	const back = <Link route={{ name: "analyses" }}>← Retour à la liste</Link>;

	if (loadError !== null) {
		return (
			<div className="space-y-4">
				{back}
				<p className="text-sm text-red-700">{loadError}</p>
			</div>
		);
	}
	if (detail === null) {
		return <p className="text-sm text-slate-500">Chargement…</p>;
	}

	const { listing, result, searches, technical, usage } = detail;
	const locales = [
		{ code: "fr", label: "FR" },
		{ code: "nl", label: "NL" },
	];

	return (
		<div className="space-y-8">
			{back}

			<Section title="Annonce">
				<dl className="space-y-1 text-sm">
					<Term label="Site">{listing.site}</Term>
					<Term label="Identifiant externe">{listing.externalId}</Term>
					{listing.url !== null && isWebUrl(listing.url) && (
						<Term label="Lien">
							<a
								href={listing.url}
								target="_blank"
								rel="noopener noreferrer"
								className="font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
							>
								Voir l'annonce
							</a>
						</Term>
					)}
					<Term label="Titre">{listing.title}</Term>
					<Term label="Description">
						<span className="whitespace-pre-wrap">{listing.description}</span>
					</Term>
					{listing.priceCents !== null && (
						<Term label="Prix">
							{formatPrice(listing.priceCents, listing.currency)}
						</Term>
					)}
					{listing.images.length > 0 && (
						<Term label="Photos">
							<ul className="space-y-1">
								{listing.images.map((url) => (
									<li key={url}>
										{isWebUrl(url) ? (
											<a
												href={url}
												target="_blank"
												rel="noopener noreferrer"
												className="text-brand-600 hover:underline"
											>
												{url}
											</a>
										) : (
											url
										)}
									</li>
								))}
							</ul>
						</Term>
					)}
					<Term label="Capturée le">{formatDateTime(listing.capturedAt)}</Term>
				</dl>
			</Section>

			<Section title="Résultat">
				<dl className="space-y-1 text-sm">
					<Term label="Score">{result.score}</Term>
					<Term label="Niveau">{LEVELS[result.level]}</Term>
					<Term label="Professionnel">
						{result.professional ? "oui" : "non"}
					</Term>
					{locales.map(({ code, label }) => {
						const text = result.texts[code];
						return text ? (
							<div key={code} className="space-y-1">
								<Term label={`Résumé (${label})`}>{text.summary}</Term>
								<Term label={`Conseil (${label})`}>{text.advice}</Term>
							</div>
						) : null;
					})}
				</dl>
				<h3 className="text-sm font-semibold">Raisons</h3>
				{result.reasons.length === 0 ? (
					<p className="text-sm text-slate-500">Aucune raison.</p>
				) : (
					<ol className="space-y-2 text-sm">
						{result.reasons.map((reason) => (
							<li key={reason.position}>
								<span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">
									{reason.severity}
								</span>
								<span lang="fr">{reason.fr}</span>
								<span className="text-slate-400"> / </span>
								<span lang="nl">{reason.nl}</span>
							</li>
						))}
					</ol>
				)}
			</Section>

			<Section title="Recherches web">
				{searches.length === 0 ? (
					<p className="text-sm text-slate-500">Aucune recherche.</p>
				) : (
					<ol className="space-y-1 text-sm">
						{searches.map((search) => (
							<li key={search.position}>
								{search.query}
								<span className="text-slate-500"> ({search.aspect})</span>
							</li>
						))}
					</ol>
				)}
			</Section>

			<Section title="Contexte technique">
				<dl className="space-y-1 text-sm">
					<Term label="Modèle">
						{technical.model.provider} / {technical.model.slug}
					</Term>
					<Term label="Prompt">
						<Link
							route={{ name: "ai", promptId: technical.promptVersionId }}
						>{`Version ${technical.promptVersion} du prompt`}</Link>
					</Term>
					<Term label="Tokens en entrée">{technical.tokensIn}</Term>
					<Term label="Tokens en sortie">{technical.tokensOut}</Term>
					<Term label="Coût">{formatUsd(technical.costUsd, 4)}</Term>
					<Term label="Photos analysées">{technical.imagesAnalyzed}</Term>
					<Term label="Empreinte d'entrée">{technical.inputHash}</Term>
					<Term label="Dernier appel">
						{formatDateTime(technical.createdAt)}
					</Term>
				</dl>
				<h3 className="text-sm font-semibold">Appels au modèle</h3>
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-xs text-slate-500">
							<tr>
								<th className="py-1 pr-4 font-medium">Date</th>
								<th className="py-1 pr-4 font-medium">Tokens en entrée</th>
								<th className="py-1 pr-4 font-medium">Tokens en sortie</th>
								<th className="py-1 pr-4 font-medium">Coût</th>
								<th className="py-1 pr-4 font-medium">Photos</th>
								<th className="py-1 font-medium">Recherches</th>
							</tr>
						</thead>
						<tbody>
							{technical.calls.map((call) => (
								<tr
									key={`${call.createdAt}-${call.tokensIn}-${call.tokensOut}`}
									className="border-t border-slate-100"
								>
									<td className="py-1 pr-4 whitespace-nowrap">
										{formatDateTime(call.createdAt)}
									</td>
									<td className="py-1 pr-4">{call.tokensIn}</td>
									<td className="py-1 pr-4">{call.tokensOut}</td>
									<td className="py-1 pr-4 whitespace-nowrap">
										{formatUsd(call.costUsd, 4)}
									</td>
									<td className="py-1 pr-4">{call.imagesAnalyzed}</td>
									<td className="py-1">{call.webSearches}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="Usage">
				<dl className="space-y-1 text-sm">
					<Term label="Servie">{usage.served}</Term>
					<Term label="Premier service">
						{formatDateTime(usage.firstServedAt)}
					</Term>
					<Term label="Dernier service">
						{formatDateTime(usage.lastServedAt)}
					</Term>
				</dl>
			</Section>
		</div>
	);
}
