import type { AnalysisResult, Locale } from "@radarnaque/shared";
import { useId } from "react";
// Erreurs qui demandent une reconnexion (RELOGIN_CODES) : on propose le bouton « Se connecter ».
import { RELOGIN_CODES } from "../lib/content/access-policy";
import type { ScanState } from "../lib/content/ai-client";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { ContentAccess } from "../lib/messages";
import { LEVEL_KEY, LEVEL_STYLE, SEVERITY_STYLE } from "./risk-styles";
import { ScanProgressView } from "./ScanProgressView";

// Erreurs de droits : on propose le lien vers les formules.
const PRICING_CODES = new Set([
	"no_active_subscription",
	"quota_exhausted",
	"feature_not_in_plan",
]);

const BUTTON_CLASS =
	"inline-flex cursor-pointer items-center justify-center rounded-[6px] border border-slate-300 bg-white px-3 py-1.5 text-[13px] leading-[1.4] font-semibold text-slate-900 shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-500";

/**
 * Analyse coupée en route (flux interrompu, délai dépassé) : le message, et
 * « Relancer » à la place de « Lancer une analyse IA ». Partagé avec la pastille.
 */
export const RELAUNCH_CODES: ReadonlySet<string> = new Set([
	"stream_interrupted",
	"timeout",
]);

const LINK_CLASS =
	"font-semibold text-slate-900 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";

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
		<section
			aria-labelledby={titleId}
			className="mt-3 border-t border-slate-200 pt-2"
		>
			<h3 id={titleId} className="m-0 mb-2 text-[14px] font-bold">
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
		<div className="flex flex-col gap-3">
			<ResultView locale={locale} result={ai.result} />
			<ScanProgressView
				progress={ai.progress}
				locale={locale}
				webSearches={ai.result.webSearches}
				live={false}
			/>
		</div>
	);
}

function AccessBody(props: AiSectionProps) {
	const { locale, access } = props;
	if (access === "loading") {
		return (
			<p className="m-0 text-slate-600">
				{contentText(locale, "ai.accessLoading")}
			</p>
		);
	}
	if ("error" in access) {
		return <ErrorNotice {...props} code={access.error} />;
	}
	if (access.status === "signedOut") {
		return (
			<div className="flex flex-col items-start gap-2">
				<p className="m-0">{contentText(locale, "ai.loginHint")}</p>
				<LoginButton {...props} />
			</div>
		);
	}
	if (access.status === "noSubscription") {
		return <ErrorNotice {...props} code="no_active_subscription" />;
	}
	return <ScanBlock {...props} />;
}

/** Le bouton d'analyse, puis l'erreur ou le déroulé en direct. */
function ScanBlock(props: AiSectionProps) {
	const { locale, ai } = props;
	const loading = ai.status === "loading";
	const relaunch = ai.status === "error" && RELAUNCH_CODES.has(ai.code);
	let label = contentText(locale, "ai.run");
	if (loading) label = contentText(locale, "ai.loading");
	else if (relaunch) label = contentText(locale, "ai.retry");
	return (
		<div className="flex flex-col items-start gap-2">
			<button
				type="button"
				disabled={loading}
				aria-busy={loading}
				onClick={() => props.onScan()}
				className={BUTTON_CLASS}
			>
				{label}
			</button>
			<div aria-live="polite" className="w-full">
				{ai.status === "error" && <ErrorNotice {...props} code={ai.code} />}
			</div>
			{/* Hors de la région annoncée : le déroulé change sans cesse. */}
			{loading && (
				<ScanProgressView progress={ai.progress} locale={locale} live />
			)}
		</div>
	);
}

/** Message d'une erreur, suivi du bouton de connexion ou du lien vers les formules selon le code. */
function ErrorNotice(props: AiSectionProps & { code: string }) {
	const { locale, code } = props;
	return (
		<div className="flex flex-col items-start gap-2">
			<p role="alert" className="m-0 text-red-800">
				{aiErrorText(locale, code)}
			</p>
			{RELOGIN_CODES.has(code) && <LoginButton {...props} />}
			{PRICING_CODES.has(code) && (
				<a
					href={props.pricingUrl}
					target="_blank"
					rel="noopener"
					className={LINK_CLASS}
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
				className={BUTTON_CLASS}
			>
				{contentText(locale, "ai.login")}
			</button>
			{props.loginUnavailable && (
				<p className="m-0 text-slate-600">
					{contentText(locale, "ai.loginFallback")}
				</p>
			)}
		</>
	);
}

function ResultView({
	locale,
	result,
}: {
	locale: Locale;
	result: AnalysisResult;
}) {
	const style = LEVEL_STYLE[result.level];
	// `null` : illimité (admin) ou sans plafond. On n'affiche alors rien, jamais « 0 ».
	const remaining = result.remaining.scans;
	return (
		<div className="flex flex-col gap-2">
			<p className="m-0 flex items-center gap-1.5 font-semibold">
				<span
					aria-hidden="true"
					className={`inline-block size-2.5 rounded-full ${style.dot}`}
				/>
				<span className={style.text}>
					{contentText(locale, LEVEL_KEY[result.level])}
				</span>
				<span className="text-slate-600">{result.score}/100</span>
			</p>
			<p className="m-0">{result.summary[locale]}</p>
			<div>
				<p className="m-0 font-semibold">{contentText(locale, "ai.advice")}</p>
				<p className="m-0">{result.advice[locale]}</p>
			</div>
			{result.reasons.length > 0 && (
				<div>
					<p className="m-0 mb-1 font-semibold">
						{contentText(locale, "ai.reasons")}
					</p>
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{result.reasons.map((reason, index) => (
							// Les raisons n'ont pas d'identifiant : l'ordre du serveur est stable.
							// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, jamais réordonnée
							<li key={index} className="flex items-start gap-2">
								<span
									className={`shrink-0 rounded-[4px] px-1.5 py-0.5 text-[11px] font-semibold ${SEVERITY_STYLE[reason.severity]}`}
								>
									{contentText(locale, `severity.${reason.severity}`)}
								</span>
								<span>{reason.text[locale]}</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{result.fromCache && (
				<p className="m-0 text-[12px] text-slate-600">
					{contentText(locale, "ai.fromCache")}
				</p>
			)}
			{result.partial && (
				<p className="m-0 text-[12px] text-slate-600">
					{contentText(locale, "ai.partial")}
				</p>
			)}
			{result.imagesAnalyzed === 0 && (
				<p className="m-0 text-[12px] text-slate-600">
					{contentText(locale, "ai.noPhoto")}
				</p>
			)}
			{remaining !== null && (
				<p className="m-0 text-[12px] text-slate-600">
					{contentText(locale, "ai.remaining").replace(
						"{count}",
						String(remaining),
					)}
				</p>
			)}
		</div>
	);
}
