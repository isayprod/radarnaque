import type { Locale } from "@radarnaque/shared";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { isDebug } from "../lib/access";
import type { AccessCache } from "../lib/content/access-policy";
import type { AiClient } from "../lib/content/ai-client";
import type { AiResultStore } from "../lib/content/ai-results";
import { statusLine } from "../lib/content/scan-progress";
import { shownResult } from "../lib/content/shown-result";
import { type AiScan, useAiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText, signalText } from "../lib/content-i18n";
import type { DebugLog } from "../lib/debug-log";
import type { Listing } from "../lib/listing/types";
import type { Severity, Signal } from "../lib/rules/rules";
import type { RiskReport } from "../lib/rules/score";
import { AiErrorBoundary } from "./AiErrorBoundary";
import { AiSection, RELAUNCH_CODES } from "./AiSection";
import { DebugBoundary, DebugSection } from "./DebugSection";
import {
	LiveLine,
	Sparkle,
	Spinner,
	useThrottled,
	useWaiting,
} from "./LiveStatus";
import { LEVEL_KEY, LEVEL_STYLE, SEVERITY_STYLE } from "./risk-styles";

const LAUNCH_CLASS =
	"inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-1 text-[12px] leading-[1.4] font-semibold text-slate-900 no-underline shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-500";

const SEVERITY_ORDER: Record<Severity, number> = {
	danger: 0,
	warning: 1,
	info: 2,
};

const byGravity = (a: Signal, b: Signal) =>
	SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];

/** Ferme le panneau sur Escape et sur tout clic hors de `ref`, tant qu'il est ouvert. */
function useDismiss(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	close: () => void,
) {
	useEffect(() => {
		const element = ref.current;
		if (!open || !element) return;
		const root = element.getRootNode();
		const host = root instanceof ShadowRoot ? root.host : null;

		// Un clic sur la page n'entre jamais dans le Shadow DOM : l'écoute se fait donc
		// sur le document, et `composedPath()` traverse la frontière du shadow root.
		// Si le shadow root est fermé, seul l'hôte apparaît dans le chemin.
		const onPointerDown = (event: Event) => {
			const path = event.composedPath();
			if (path.includes(element) || (host && path.includes(host))) return;
			close();
		};
		// Escape est consommé ici, en tout premier (window, capture) : la modale de
		// l'annonce Facebook, dessous, ne doit pas se fermer en même temps.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open, ref, close]);
}

/** Signaux de l'analyse locale, par gravité ; `panel.none` s'il n'y en a aucun. */
function LocalSignals({
	locale,
	signals,
}: {
	locale: Locale;
	signals: Signal[];
}) {
	if (signals.length === 0)
		return <p className="m-0">{contentText(locale, "panel.none")}</p>;
	return (
		<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
			{[...signals].sort(byGravity).map((signal) => (
				<li key={signal.id} className="flex items-start gap-2">
					<span
						className={`shrink-0 rounded-[4px] px-1.5 py-0.5 text-[11px] font-semibold ${SEVERITY_STYLE[signal.severity]}`}
					>
						{contentText(locale, `severity.${signal.severity}`)}
					</span>
					<span>{signalText(locale, signal)}</span>
				</li>
			))}
		</ul>
	);
}

/**
 * Bandeau des annonces professionnelles : une information neutre (ardoise),
 * jamais une alerte. Il s'ajoute au score, il ne le remplace pas.
 */
function ProNotice({ locale }: { locale: Locale }) {
	return (
		<p
			role="note"
			className="m-0 mb-2 rounded-[6px] border border-slate-300 bg-slate-50 px-2 py-1.5 text-[12px] leading-[1.4] text-slate-700"
		>
			{contentText(locale, "pro.notice")}
		</p>
	);
}

type Access = AiScan["access"];

/**
 * Clic sur « Analyser avec l'IA » : l'analyse si le compte en a encore, la
 * connexion s'il est déconnecté. Accès inconnu ou déconnecté (R8 : toujours relu),
 * l'accès est d'abord lu, puis l'action suit la réponse. Un accès en erreur, ou
 * sans abonnement d'après la lecture, ouvre le panneau, qui dit pourquoi.
 */
function useLaunch(scan: AiScan, key: string, openPanel: () => void) {
	const { access, loadAccess, login } = scan;
	const start = scan.scan;
	// Accès vu au clic, en attente d'une nouvelle lecture ; null sans clic en attente.
	// Chaque lecture donne un objet neuf (clone du message du service worker) : un
	// accès différent de `from` est la réponse attendue. Sans clic, rien n'est lu.
	const pendingRef = useRef<{ from: Access } | null>(null);
	const act = useCallback(
		(reading: Access) => {
			if (reading === "loading") return;
			if ("error" in reading || reading.status === "noSubscription")
				openPanel();
			else if (reading.status === "signedOut") login();
			else if (reading.remaining.scans !== 0) start();
		},
		[openPanel, login, start],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` oublie le clic en attente d'une annonce quittée
	useEffect(() => {
		pendingRef.current = null;
	}, [key]);
	useEffect(() => {
		const pending = pendingRef.current;
		if (!pending || access === pending.from || access === "loading") return;
		pendingRef.current = null;
		act(access);
	}, [access, act]);
	return useCallback(() => {
		if (
			access === "loading" ||
			(!("error" in access) && access.status === "signedOut")
		) {
			pendingRef.current = { from: access };
			loadAccess();
			return;
		}
		act(access);
	}, [access, act, loadAccess]);
}

/**
 * Bouton « Analyser avec l'IA » de la pastille : un lien vers les formules sans
 * abonnement, grisé sans analyse restante.
 */
function LaunchButton({
	access,
	locale,
	pricingUrl,
	onLaunch,
}: {
	access: Access;
	locale: Locale;
	pricingUrl: string;
	onLaunch(): void;
}) {
	const label = contentText(locale, "ai.launch");
	const content = (
		<>
			<Sparkle />
			{contentText(locale, "ai.launchShort")}
		</>
	);
	const known = access !== "loading" && !("error" in access);
	if (known && access.status === "noSubscription") {
		return (
			<a
				href={pricingUrl}
				target="_blank"
				rel="noopener"
				aria-label={label}
				className={LAUNCH_CLASS}
			>
				{content}
			</a>
		);
	}
	const empty =
		known && access.status === "active" && access.remaining.scans === 0;
	return (
		<button
			type="button"
			aria-label={label}
			disabled={empty}
			title={empty ? contentText(locale, "ai.noScansLeft") : undefined}
			onClick={onLaunch}
			className={LAUNCH_CLASS}
		>
			{content}
		</button>
	);
}

export function RiskBadge({
	report,
	listing,
	locale,
	ai,
	accessCache,
	aiResults,
	debugLog,
}: {
	report: RiskReport;
	listing: Listing;
	locale: Locale;
	/** Client IA injecté par le content script (`createAiClient()`). */
	ai: AiClient;
	/** Accès partagé avec les icônes de cartes (R8), un par content script. */
	accessCache?: AccessCache;
	/** Résultats IA gardés 24 h, partagés avec les icônes de cartes. */
	aiResults?: AiResultStore;
	/** Logs de debug du superuser (scan demandé, scan reçu). */
	debugLog?: DebugLog;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const levelId = useId();
	const scoreId = useId();
	const close = useCallback(() => setOpen(false), []);
	const openPanel = useCallback(() => setOpen(true), []);
	useDismiss(open, rootRef, close);
	// L'état IA vit ici, pas dans le panneau : il survit à sa fermeture.
	const scan = useAiScan(
		ai,
		{ report, listing },
		locale,
		accessCache,
		aiResults,
		debugLog,
	);
	const { loadAccess } = scan;
	// Accès lu à l'ouverture du panneau, jamais avant. Panneau ouvert, il est relu
	// au retour sur l'onglet (connexion faite dans la popup) ; `loadAccess` ne fait
	// rien s'il est déjà actif.
	useEffect(() => {
		if (!open) return;
		loadAccess();
		const onFocus = () => loadAccess();
		const onVisibility = () => {
			if (document.visibilityState === "visible") loadAccess();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [open, loadAccess]);

	// Dès qu'un résultat IA existe, il remplace l'analyse locale dans la pastille
	// et dans le panneau.
	const shown = shownResult(scan.ai);
	const level = shown ? shown.level : report.level;
	const score = shown ? shown.score : report.score;
	const style = LEVEL_STYLE[level];
	const title = contentText(locale, shown ? "panel.titleAi" : "panel.title");
	// Vendeur déclaré professionnel par le site, ou détecté par l'IA.
	// Section Debug : le serveur a renvoyé `debug` ET l'accès lu est celui du
	// superuser. Un résultat repris du magasin n'a jamais de `debug`.
	const debug =
		shown?.debug &&
		scan.access !== "loading" &&
		!("error" in scan.access) &&
		isDebug(scan.access)
			? shown.debug
			: null;
	const professional =
		listing.seller.sellerKind === "professional" ||
		shown?.professional === true;

	const launch = useLaunch(
		scan,
		`${listing.site}|${listing.externalId}`,
		openPanel,
	);
	// Analyse en cours : l'icône qui tourne et la ligne d'état du dernier événement.
	const progress = scan.ai.status === "loading" ? scan.ai.progress : null;
	const line = progress ? statusLine(progress, locale) : "";
	const waiting = useWaiting(progress?.lastAt ?? 0, progress !== null);
	// Coupée en route : le message et « Relancer » à la place du bouton.
	const relaunch =
		scan.ai.status === "error" && RELAUNCH_CODES.has(scan.ai.code)
			? aiErrorText(locale, scan.ai.code)
			: null;
	const announced = useThrottled(line || relaunch || "");

	// Police en px et reset explicite : le site hôte ne doit ni agrandir ni styler la pastille.
	return (
		<div
			ref={rootRef}
			className="radarnaque-root relative ml-2 inline-block align-middle text-[13px] leading-[1.4] font-normal"
		>
			<span className="inline-flex flex-wrap items-center gap-1.5">
				<button
					type="button"
					aria-expanded={open}
					aria-label={contentText(
						locale,
						shown ? "badge.ariaAi" : "badge.aria",
					)}
					aria-describedby={`${levelId} ${scoreId}`}
					onClick={() => setOpen((value) => !value)}
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[13px] leading-[1.4] font-semibold shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
				>
					<span
						aria-hidden="true"
						className={`inline-block size-2.5 rounded-full ${style.dot}`}
					/>
					<span id={levelId} className={style.text}>
						{contentText(locale, LEVEL_KEY[level])}
					</span>
					<span id={scoreId} className="text-slate-600">
						{score}/100
					</span>
					{shown && (
						<span className="rounded-[4px] bg-slate-100 px-1 py-px text-[11px] font-bold text-slate-700">
							{contentText(locale, "ai.badgeTag")}
						</span>
					)}
					{progress && (
						<>
							<Spinner />
							<LiveLine text={line} waiting={waiting} />
						</>
					)}
				</button>
				{relaunch !== null && (
					<>
						<span className="text-[12px] font-semibold text-red-800">
							{relaunch}
						</span>
						<button type="button" onClick={launch} className={LAUNCH_CLASS}>
							{contentText(locale, "ai.retry")}
						</button>
					</>
				)}
				{!shown && !progress && relaunch === null && (
					<LaunchButton
						access={scan.access}
						locale={locale}
						pricingUrl={scan.pricingUrl}
						onLaunch={launch}
					/>
				)}
			</span>
			{/* Annonces de la ligne d'état : au plus une toutes les 2 s. */}
			<span role="status" aria-live="polite" className="sr-only">
				{announced}
			</span>
			{open && (
				<div
					role="dialog"
					aria-label={title}
					className="absolute top-full left-0 z-[2147483647] mt-1.5 w-[320px] max-w-[90vw] rounded-[8px] border border-slate-300 bg-white p-3 text-[13px] leading-[1.4] text-slate-900 shadow-lg"
				>
					{professional && <ProNotice locale={locale} />}
					<h2 className="m-0 mb-2 text-[14px] font-bold">{title}</h2>
					{/* Résultat IA présent : la liste des signaux locaux disparaît. */}
					{!shown && <LocalSignals locale={locale} signals={report.signals} />}
					<AiErrorBoundary
						key={`${listing.site}|${listing.externalId}`}
						locale={locale}
					>
						<AiSection
							locale={locale}
							access={scan.access}
							ai={scan.ai}
							onScan={() => scan.scan()}
							onLogin={scan.login}
							loginUnavailable={scan.loginUnavailable}
							pricingUrl={scan.pricingUrl}
						/>
						{debug && (
							// Nouvelle tentative de rendu pour chaque nouveau bloc debug. La durée
							// totale distingue une relance sans cache, qui réécrit l'analyse en
							// place (même analysisId, même inputHash).
							<DebugBoundary
								key={`${listing.site}|${listing.externalId}|${debug.analysisId}|${debug.inputHash}|${debug.timingsMs.total}`}
							>
								<DebugSection
									locale={locale}
									debug={debug}
									rescanning={scan.rescanning}
									onRescan={scan.rescan}
									error={scan.rescanError ?? undefined}
								/>
							</DebugBoundary>
						)}
					</AiErrorBoundary>
					{!shown && (
						<p className="m-0 mt-3 border-t border-slate-200 pt-2 text-[12px] text-slate-600">
							{contentText(locale, "panel.footer")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
