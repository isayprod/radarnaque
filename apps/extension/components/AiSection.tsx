import type { AnalysisResult, Locale } from "@radarnaque/shared";
import { useId } from "react";
// Erreurs qui demandent une reconnexion (RELOGIN_CODES) : on propose le bouton « Se connecter ».
import { RELOGIN_CODES } from "../lib/content/access-policy";
import type { ScanState } from "../lib/content/ai-client";
import type { ScanProgress } from "../lib/content/scan-progress";
import { aiErrorText, type ContentKey, contentText } from "../lib/content-i18n";
import type { ContentAccess } from "../lib/messages";
import {
	LABEL_CLASS,
	LEVEL_KEY,
	LEVEL_STYLE,
	SEVERITY_STYLE,
} from "./risk-styles";
import { ScanProgressView } from "./ScanProgressView";

// Erreurs de droits : on propose le lien vers les formules.
const PRICING_CODES = new Set([
	"no_active_subscription",
	"quota_exhausted",
	"feature_not_in_plan",
]);

/**
 * Action principale du panneau : pilule blanche, texte sombre, ombre de la pilule
 * primaire (DESIGN.md, boutons « Primary »). Grisée à 40 % une fois désactivée.
 */
const WHITE_PILL_CLASS =
	"inline-flex h-8 cursor-pointer items-center justify-center rounded-pill bg-white px-4 text-[13px] leading-none font-medium whitespace-nowrap text-text-on-light no-underline shadow-[var(--shadow-pill)] hover:-translate-y-px focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0";

/** Phrase d'un état sans résultat (déconnecté, sans abonnement, erreur) : titre serif. */
const STATE_TITLE_CLASS =
	"m-0 font-serif text-[22px] leading-[1.15] font-normal text-text-1";

/**
 * Mentions et métadonnées du pied : `text-xs`, en px (taille `html` du site
 * ignorée), en `--text-2` : texte à lire, 4,5:1 au moins sur le verre des pages tierces.
 */
const META_CLASS = "m-0 text-[12px] leading-[1.4] text-text-2";

/**
 * Analyse coupée en route (flux interrompu, délai dépassé) : le message, et
 * « Relancer » à la place de « Lancer une analyse IA ». Partagé avec la pastille.
 */
export const RELAUNCH_CODES: ReadonlySet<string> = new Set([
	"stream_interrupted",
	"timeout",
]);

export interface AiSectionProps {
	locale: Locale;
	access: ContentAccess | "loading" | { error: string };
	/** L'analyse IA de l'annonce : une seule action, une seule place. */
	ai: ScanState;
	onScan(): void;
	onLogin(): void;
	loginUnavailable: boolean;
	pricingUrl: string;
}

/**
 * Section IA du panneau. Composant contrôlé : il n'a aucun état réseau propre,
 * l'accès et l'état des analyses viennent du parent. Tout texte de l'IA est rendu
 * en nœuds texte, jamais en HTML.
 */
export function AiSection(props: AiSectionProps) {
	const titleId = useId();
	return (
		<section aria-labelledby={titleId}>
			{/* Le panneau a son en-tête visible : ce titre ne sert qu'aux lecteurs d'écran. */}
			<h3 id={titleId} className="sr-only">
				{contentText(props.locale, "ai.title")}
			</h3>
			<SectionBody {...props} />
		</section>
	);
}

/**
 * Un résultat IA existe : il est affiché quel que soit l'accès (repris du
 * magasin avant la lecture de l'accès, ou session expirée depuis), sans aucun
 * bouton : relancer la même analyse ne servirait à rien. Son déroulé est replié
 * dessous.
 */
function SectionBody(props: AiSectionProps) {
	const { locale, ai } = props;
	if (ai.status !== "done") return <AccessBody {...props} />;
	return (
		<ResultView locale={locale} result={ai.result} progress={ai.progress} />
	);
}

function AccessBody(props: AiSectionProps) {
	const { locale, access } = props;
	if (access === "loading") {
		return (
			<p className="m-0 text-text-2">
				{contentText(locale, "ai.accessLoading")}
			</p>
		);
	}
	if ("error" in access) {
		return <ErrorNotice {...props} code={access.error} />;
	}
	if (access.status === "signedOut") {
		return (
			<div className="flex flex-col items-start gap-3">
				<p className={STATE_TITLE_CLASS}>
					{contentText(locale, "ai.loginHint")}
				</p>
				<LoginButton {...props} />
			</div>
		);
	}
	if (access.status === "noSubscription") {
		return <ErrorNotice {...props} code="no_active_subscription" />;
	}
	return <ScanBlock {...props} />;
}

/**
 * L'erreur de la dernière analyse (titre serif et son action), puis le bouton
 * d'analyse en pilule blanche, et le déroulé en direct.
 */
function ScanBlock(props: AiSectionProps) {
	const { locale, ai } = props;
	const loading = ai.status === "loading";
	const relaunch = ai.status === "error" && RELAUNCH_CODES.has(ai.code);
	let label = contentText(locale, "ai.run");
	if (loading) label = contentText(locale, "ai.loading");
	else if (relaunch) label = contentText(locale, "ai.retry");
	return (
		<div className="flex flex-col items-start">
			{/* Région présente avant l'erreur, pour qu'elle soit annoncée. */}
			<div aria-live="polite" className="w-full">
				{ai.status === "error" && (
					<div className="mb-3">
						<ErrorNotice {...props} code={ai.code} />
					</div>
				)}
			</div>
			<button
				type="button"
				disabled={loading}
				aria-busy={loading}
				onClick={() => props.onScan()}
				className={WHITE_PILL_CLASS}
			>
				{label}
			</button>
			{/* Hors de la région annoncée : le déroulé change sans cesse. */}
			{loading && (
				<div className="mt-3 w-full">
					<ScanProgressView progress={ai.progress} locale={locale} live />
				</div>
			)}
		</div>
	);
}

/**
 * Message d'une erreur en titre serif, suivi du bouton de connexion ou du lien
 * vers les formules (pilule blanche) selon le code.
 */
function ErrorNotice(props: AiSectionProps & { code: string }) {
	const { locale, code } = props;
	return (
		<div className="flex flex-col items-start gap-3">
			<p role="alert" className={STATE_TITLE_CLASS}>
				{aiErrorText(locale, code)}
			</p>
			{RELOGIN_CODES.has(code) && <LoginButton {...props} />}
			{PRICING_CODES.has(code) && (
				<a
					href={props.pricingUrl}
					target="_blank"
					rel="noopener"
					className={WHITE_PILL_CLASS}
				>
					{contentText(locale, "ai.pricing")}
				</a>
			)}
		</div>
	);
}

function LoginButton(props: AiSectionProps) {
	const { locale } = props;
	return (
		<>
			<button
				type="button"
				onClick={() => props.onLogin()}
				className={WHITE_PILL_CLASS}
			>
				{contentText(locale, "ai.login")}
			</button>
			{props.loginUnavailable && (
				<p className="m-0 text-[12px] leading-[1.4] text-text-2">
					{contentText(locale, "ai.loginFallback")}
				</p>
			)}
		</>
	);
}

/**
 * Le résultat : bloc du score (nombre serif, « /100 », badge de verdict, barre),
 * résumé, conseil, raisons, puis le pied (analyses restantes, déroulé replié,
 * mentions).
 */
function ResultView({
	locale,
	result,
	progress,
}: {
	locale: Locale;
	result: AnalysisResult;
	progress: ScanProgress | null;
}) {
	const style = LEVEL_STYLE[result.level];
	const level = contentText(locale, LEVEL_KEY[result.level]);
	// `null` : illimité (admin) ou sans plafond. On n'affiche alors rien, jamais « 0 ».
	const remaining = result.remaining.scans;
	const width = `${Math.min(100, Math.max(0, result.score))}%`;
	const mentions: ContentKey[] = [];
	if (result.fromCache) mentions.push("ai.fromCache");
	if (result.partial) mentions.push("ai.partial");
	if (result.imagesAnalyzed === 0) mentions.push("ai.noPhoto");
	// Même condition que ScanProgressView, qui ne rend rien sans étape ni recherche.
	const hasSteps =
		(progress?.steps.length ?? 0) > 0 || result.webSearches.length > 0;
	const hasFooter = remaining !== null || hasSteps || mentions.length > 0;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-3">
				{/* Verdict avant le score dans le DOM (lu comme la pilule : niveau, puis
				    score), affiché à droite du nombre (`flex-row-reverse`). */}
				<div className="flex flex-row-reverse items-end justify-between gap-3">
					<span
						data-verdict=""
						className={`mb-1.5 inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-[12px] leading-none font-medium ${style.soft} ${style.text}`}
					>
						<span
							aria-hidden="true"
							className={`size-1.5 shrink-0 rounded-full ${style.dot}`}
						/>
						<span>{level}</span>
					</span>
					<p className="m-0 flex items-baseline gap-1">
						<span className="font-serif text-[44px] leading-none font-normal tracking-[-0.02em] text-text-1 tabular-nums">
							{result.score}
						</span>
						<span className="text-[13px] text-text-2 tabular-nums">/100</span>
					</p>
				</div>
				<div
					role="presentation"
					className="h-1 w-full overflow-hidden rounded-pill bg-white/10"
				>
					<div
						className={`h-full rounded-pill ${style.bar}`}
						style={{ width }}
					/>
				</div>
			</div>
			<p className="m-0 text-[14px] leading-[1.5] text-text-1">
				{result.summary[locale]}
			</p>
			<div className="flex flex-col gap-1">
				<p className={LABEL_CLASS}>{contentText(locale, "ai.advice")}</p>
				<p className="m-0 text-text-2">{result.advice[locale]}</p>
			</div>
			{result.reasons.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className={LABEL_CLASS}>{contentText(locale, "ai.reasons")}</p>
					<ul className="m-0 flex list-none flex-col gap-2 p-0">
						{result.reasons.map((reason, index) => (
							// Les raisons n'ont pas d'identifiant : l'ordre du serveur est stable.
							// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, jamais réordonnée
							<li key={index} className="flex items-start gap-2">
								<span
									className={`inline-flex h-5 shrink-0 items-center rounded-pill px-2 text-[11px] leading-none font-medium ${SEVERITY_STYLE[reason.severity]}`}
								>
									{contentText(locale, `severity.${reason.severity}`)}
								</span>
								<span className="text-text-2">{reason.text[locale]}</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{hasFooter && (
				<footer className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
					<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
						{remaining !== null && (
							<p className={`${META_CLASS} tabular-nums`}>
								{contentText(locale, "ai.remaining").replace(
									"{count}",
									String(remaining),
								)}
							</p>
						)}
						<ScanProgressView
							progress={progress}
							locale={locale}
							webSearches={result.webSearches}
							live={false}
						/>
					</div>
					{mentions.map((key) => (
						<p key={key} className={META_CLASS}>
							{contentText(locale, key)}
						</p>
					))}
				</footer>
			)}
		</div>
	);
}
