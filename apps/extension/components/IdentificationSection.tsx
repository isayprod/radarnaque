import type { IdentificationResult, Locale } from "@radarnaque/shared";
import { useEffect, useId, useRef, useState } from "react";
import type { IdentifyState } from "../lib/content/ai-client";
import {
	CONFIDENCE_GLYPH,
	CONFIDENCE_KEY,
	identificationHeadline,
} from "../lib/content/identification-headline";
import { progressFromSearches } from "../lib/content/identification-progress";
import { statusLine } from "../lib/content/scan-progress";
import { type ContentKey, contentText } from "../lib/content-i18n";
import {
	type AccessActionsProps,
	AccessBody,
	ErrorNotice,
	hasOwnAction,
	SECONDARY_PILL_CLASS,
	STATE_TITLE_CLASS,
	WHITE_PILL_CLASS,
} from "./AiSection";
import { LiveLine, useWaiting } from "./LiveStatus";
import { LABEL_CLASS } from "./risk-styles";
import { ScanProgressView } from "./ScanProgressView";

export interface IdentificationSectionProps extends AccessActionsProps {
	identification: IdentifyState;
	onIdentify(): void;
	/**
	 * Section reprise sous l'analyse du risque (« Détail du produit ») : son pied
	 * ne répète pas « Analyses restantes », déjà dit par la section du risque.
	 */
	hideRemaining?: boolean;
	/**
	 * Plus d'analyse restante d'après l'accès lu : « Identifier le produit » est
	 * grisé (`aria-disabled`, raison lue avec lui). Le clic passe toujours au
	 * parent, dont `useLaunch` ne lance rien.
	 */
	empty?: boolean;
	/**
	 * Identifiant du titre visible que le parent donne à la section (« Produit »,
	 * ou le `<summary>` de « Détail du produit ») : il la nomme, à la place du
	 * titre caché « Identification », qui le répéterait.
	 */
	labelledBy?: string;
}

type IdentifiedObject = IdentificationResult["objects"][number];
type Check = IdentifiedObject["checks"][number];
type PageLink = IdentifiedObject["pages"][number];

/** Durée du retour « Copié » sur le bouton. */
const COPIED_MS = 2000;

/** Mentions et métadonnées du pied (comme `AiSection`). */
const META_CLASS = "m-0 text-[12px] leading-[1.4] text-text-2";

const LINK_CLASS =
	"text-text-1 underline underline-offset-2 hover:text-text-2 focus-visible:rounded-xs focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden";

/** Glyphe et texte caché (lecteurs d'écran) de chaque observation d'un critère. */
const OBSERVATION: Record<Check["observation"], [string, ContentKey]> = {
	seen_match: ["✓", "identify.check.match"],
	seen_contrary: ["✗", "identify.check.contrary"],
	not_visible: ["?", "identify.check.notVisible"],
};

/**
 * Adresse sûre d'un lien : `https://` seulement (le service worker l'a déjà
 * filtrée, on ne s'y fie pas). Sinon null : le titre reste du texte.
 */
function safeHref(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" ? parsed.href : null;
	} catch {
		return null;
	}
}

/**
 * Panneau Identification. Composant contrôlé : l'état vient du parent. Un
 * résultat est affiché quel que soit l'accès ; sinon les états d'accès et
 * d'erreur, comme la section IA. Tout texte venu du réseau est rendu en nœuds
 * texte, jamais en HTML.
 */
export function IdentificationSection(props: IdentificationSectionProps) {
	const titleId = useId();
	const { locale, identification, labelledBy } = props;
	return (
		<section aria-labelledby={labelledBy ?? titleId}>
			{/* Sans titre visible du parent, celui-ci ne sert qu'aux lecteurs d'écran. */}
			{labelledBy === undefined && (
				<h3 id={titleId} className="sr-only">
					{contentText(locale, "identify.title")}
				</h3>
			)}
			{identification.status === "done" ? (
				<ResultView
					locale={locale}
					access={props.access}
					result={identification.result}
					progress={identification.progress}
					hideRemaining={props.hideRemaining === true}
				/>
			) : (
				<AccessBody {...props}>
					<IdentifyBlock {...props} />
				</AccessBody>
			)}
		</section>
	);
}

/**
 * Accès actif : l'erreur de la dernière identification, le bouton « Identifier
 * le produit », et la ligne d'état pendant l'identification. Comme « Analyser
 * le risque » (`RiskAction`) : le parent passe l'action par `useLaunch` ;
 * grisé (`aria-disabled`, focusable, raison lue avec lui) sans analyse
 * restante ; pendant l'identification, `aria-disabled` et clic ignoré, pour
 * que le bouton garde le focus clavier. L'erreur s'annonce par son propre
 * `role="alert"` (`ErrorNotice`), sans région `aria-live` autour.
 */
function IdentifyBlock(props: IdentificationSectionProps) {
	const { locale, identification } = props;
	const reasonId = useId();
	const empty = props.empty === true;
	const progress =
		identification.status === "loading" ? identification.progress : null;
	const loading = progress !== null;
	const waiting = useWaiting(progress?.lastAt ?? 0, loading);
	// L'erreur affichée a déjà sa pilule blanche (connexion, formules).
	const errorHasAction =
		identification.status === "error" && hasOwnAction(identification.code);
	const reason = contentText(locale, "ai.noScansLeft");
	return (
		<div className="flex flex-col items-start gap-3">
			{identification.status === "error" && (
				<div className="w-full">
					<ErrorNotice {...props} code={identification.code} />
				</div>
			)}
			<button
				type="button"
				aria-busy={loading}
				aria-disabled={empty || loading ? true : undefined}
				aria-describedby={empty ? reasonId : undefined}
				title={empty ? reason : undefined}
				onClick={() => {
					if (!loading) props.onIdentify();
				}}
				className={`${errorHasAction ? SECONDARY_PILL_CLASS : WHITE_PILL_CLASS} aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:translate-y-0`}
			>
				{contentText(locale, "identify.launch")}
			</button>
			{empty && (
				<span id={reasonId} className="sr-only">
					{reason}
				</span>
			)}
			{progress && (
				<LiveLine
					text={statusLine(progress, locale, "identify.start")}
					waiting={waiting}
				/>
			)}
			{/* Hors de la région annoncée : le déroulé change sans cesse. */}
			{progress && (
				<div className="w-full">
					<ScanProgressView progress={progress} locale={locale} live />
				</div>
			)}
		</div>
	);
}

/** Domaine d'une source ou d'une page : lien `https://`, sinon texte seul. */
function Domain({ page }: { page: PageLink }) {
	const href = safeHref(page.url);
	if (!href) return <span>{page.domain}</span>;
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className={LINK_CLASS}
		>
			{page.domain}
		</a>
	);
}

function CheckItem({ check, locale }: { check: Check; locale: Locale }) {
	const [glyph, key] = OBSERVATION[check.observation];
	return (
		<li className="flex items-start gap-2">
			<span aria-hidden="true" className="w-3 shrink-0 text-text-1">
				{glyph}
			</span>
			<span className="sr-only">{contentText(locale, key)}</span>
			<span className="min-w-0 break-words text-text-2">
				{check.text[locale]}
				{check.photo !== null && (
					<span className="tabular-nums">
						{" "}
						(
						{contentText(locale, "identify.photo").replace(
							"{n}",
							String(check.photo),
						)}
						)
					</span>
				)}
				{/* Une même page peut revenir : la clé est la position. */}
				{check.sources.map((source, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, URL possiblement en double
					<span key={i}>
						{" "}
						<Domain page={source} />
					</span>
				))}
			</span>
		</li>
	);
}

/** Question au vendeur dans un encadré, avec « Copier » (« Copié » pendant 2 s). */
function SellerQuestion({
	locale,
	text,
	missing,
}: {
	locale: Locale;
	text: string;
	/** Critères non visibles sur les photos, dits au-dessus de la question. */
	missing: string[];
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// Faux après le démontage : une copie terminée ensuite ne fait plus rien.
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearTimeout(timer.current);
		};
	}, []);
	const copy = () => {
		let pending: Promise<void>;
		try {
			pending = navigator.clipboard.writeText(text);
		} catch {
			// Presse-papiers absent : rien à signaler, la question reste lisible.
			return;
		}
		pending.then(
			() => {
				if (!mountedRef.current) return;
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), COPIED_MS);
			},
			() => {},
		);
	};
	return (
		<div className="flex flex-col items-start gap-2 rounded-sm bg-white/5 px-3 py-2.5">
			<p className={LABEL_CLASS}>{contentText(locale, "identify.askSeller")}</p>
			{missing.length > 0 && (
				<p className={`${META_CLASS} break-words`}>
					{contentText(locale, "identify.notVisibleList").replace(
						"{list}",
						() => missing.join(", "),
					)}
				</p>
			)}
			<p className="m-0 break-words text-text-1">{text}</p>
			<button
				type="button"
				onClick={copy}
				className={`${SECONDARY_PILL_CLASS} h-7 px-3 text-[12px]`}
			>
				{contentText(locale, copied ? "identify.copied" : "identify.copy")}
			</button>
			{/* Annonce le retour du bouton aux lecteurs d'écran. */}
			<span aria-live="polite" className="sr-only">
				{copied ? contentText(locale, "identify.copied") : ""}
			</span>
		</div>
	);
}

/** Badge de niveau (glyphe, niveau, pourcentage) : un fond neutre, jamais une couleur de risque. */
function LevelBadge({
	glyph,
	level,
	percent,
}: {
	glyph: string;
	level: string;
	percent: string;
}) {
	return (
		<span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-pill bg-white/10 px-2.5 text-[12px] leading-none font-medium text-text-1">
			<span aria-hidden="true">{glyph}</span>
			<span>{level}</span>
			<span className="tabular-nums">{percent}</span>
		</span>
	);
}

/** Le résultat : objet principal, critères, question au vendeur, accessoires, pages, pied. */
function ResultView({
	locale,
	access,
	result,
	progress,
	hideRemaining,
}: {
	locale: Locale;
	hideRemaining: boolean;
	access: AccessActionsProps["access"];
	result: IdentificationResult;
	progress: Extract<IdentifyState, { status: "done" }>["progress"];
}) {
	const headline = identificationHeadline(result, locale);
	const main =
		result.objects.find((o) => o.role === "main") ?? result.objects[0];
	const accessories = result.objects.filter(
		(o) => o !== main && o.role === "accessory",
	);
	const question = result.sellerQuestion?.[locale] ?? "";
	// `null` : illimité ou sans plafond (rien à dire, jamais « 0 »). Le résultat
	// porte le décompte du serveur ; un résultat repris du magasin porte
	// `{ scans: null }` (`withoutRemaining`) et n'affiche rien.
	const accessRemaining =
		access !== "loading" && !("error" in access) && access.status === "active"
			? access.remaining.scans
			: null;
	// Le repli sur l'accès lu ne vaut que pour une identification sans
	// `remaining` (celle embarquée dans une analyse) : un `scans` nul dans le
	// résultat dit « illimité » (comme `AiSection`).
	const shownRemaining = result.remaining
		? result.remaining.scans
		: accessRemaining;
	const remaining = hideRemaining ? null : shownRemaining;
	const live = progress && progress.steps.length > 0 ? progress : null;
	const shownProgress = live ?? progressFromSearches(result.searches);
	const hasSteps = shownProgress.steps.length > 0;
	const hasFooter = remaining !== null || hasSteps;
	const width = `${Math.min(100, Math.max(0, result.confidence))}%`;
	return (
		<div className="flex flex-col gap-4">
			{headline && main ? (
				<div className="flex flex-col gap-3">
					<p className="m-0 font-serif text-[22px] leading-[1.15] font-normal break-words text-text-1">
						{headline.reference}
					</p>
					<LevelBadge
						glyph={headline.glyph}
						level={headline.level}
						percent={headline.percent}
					/>
					<div
						role="presentation"
						className="h-1 w-full overflow-hidden rounded-pill bg-white/10"
					>
						<div
							className="h-full rounded-pill bg-text-1/60"
							style={{ width }}
						/>
					</div>
				</div>
			) : (
				<p className={STATE_TITLE_CLASS}>
					{contentText(locale, "identify.none")}
				</p>
			)}
			{(result.verifiedCriteria || result.unsourced) && (
				<div className="flex flex-col gap-1">
					{result.verifiedCriteria && (
						<p className={META_CLASS}>
							{contentText(locale, "identify.verified")}
						</p>
					)}
					{result.unsourced && (
						<p className={META_CLASS}>
							{contentText(locale, "identify.unsourced")}
						</p>
					)}
				</div>
			)}
			{main && main.checks.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className={LABEL_CLASS}>
						{contentText(locale, "identify.criteria")}
					</p>
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{main.checks.map((check, index) => (
							// Les critères n'ont pas d'identifiant : l'ordre du serveur est stable.
							// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, jamais réordonnée
							<CheckItem key={index} check={check} locale={locale} />
						))}
					</ul>
				</div>
			)}
			{result.status === "uncertain" && main && main.remaining.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className={LABEL_CLASS}>
						{contentText(locale, "identify.candidates")}
					</p>
					<ul className="m-0 flex list-none flex-col gap-1 p-0 text-text-2">
						{main.remaining.map((candidate, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, jamais réordonnée
							<li key={index} className="break-words">
								{candidate}
							</li>
						))}
					</ul>
				</div>
			)}
			{question && (
				<SellerQuestion
					locale={locale}
					text={question}
					missing={
						result.status === "uncertain" && main
							? main.checks
									.filter((check) => check.observation === "not_visible")
									.map((check) => check.text[locale])
							: []
					}
				/>
			)}
			{accessories.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className={LABEL_CLASS}>
						{contentText(locale, "identify.accessories")}
					</p>
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{accessories.map((object, index) => (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, jamais réordonnée
								key={index}
								className="flex items-start justify-between gap-2"
							>
								<span className="min-w-0 break-words text-text-2">
									{object.label || contentText(locale, "identify.object")}
									{" · "}
									{object.reference || "—"}
								</span>
								<span className="shrink-0 text-text-2">
									<span aria-hidden="true">
										{CONFIDENCE_GLYPH[object.level]}{" "}
									</span>
									{contentText(locale, CONFIDENCE_KEY[object.level])}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{main && main.pages.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className={LABEL_CLASS}>{contentText(locale, "identify.pages")}</p>
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{main.pages.map((page, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: liste figée, jamais réordonnée
							<li key={index} className="min-w-0 break-words text-text-2">
								<PageItem page={page} />
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
							progress={shownProgress}
							locale={locale}
							live={false}
							summary="identify.howIdentified"
							timed={live !== null}
						/>
					</div>
				</footer>
			)}
		</div>
	);
}

/** Une page de référence : le titre (lien `https://`), puis son domaine. */
function PageItem({ page }: { page: PageLink }) {
	const href = safeHref(page.url);
	return (
		<>
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					className={LINK_CLASS}
				>
					{page.title || page.domain}
				</a>
			) : (
				<span>{page.title || page.domain}</span>
			)}
			{page.title && <span className="text-text-2"> · {page.domain}</span>}
		</>
	);
}
