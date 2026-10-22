import type { Locale } from "@radarnaque/shared";
import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import type { ScanState } from "../lib/content/ai-client";
import { statusLine } from "../lib/content/scan-progress";
import { shownResult } from "../lib/content/shown-result";
import type { AiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { RELAUNCH_CODES } from "./AiSection";
import { LiveLine, Spinner, useThrottled, useWaiting } from "./LiveStatus";
import { LEVEL_KEY, LEVEL_STYLE } from "./risk-styles";

type Access = AiScan["access"];

// Pilule qui ouvre le panneau : analyse en cours, ou résultat IA.
const TOGGLE_CLASS =
	"inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[13px] leading-[1.4] font-semibold shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";

// Pilule qui lance l'analyse : au repos, ou après une erreur.
const LAUNCH_CLASS =
	"inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-1 text-[12px] leading-[1.4] font-semibold text-slate-900 no-underline shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 aria-disabled:cursor-default aria-disabled:bg-slate-100 aria-disabled:text-slate-500";

/** Plus aucune analyse d'après l'accès lu (quota du plan ou plafond de l'essai). */
const noScansLeft = (access: Access) =>
	access !== "loading" &&
	!("error" in access) &&
	access.status === "active" &&
	access.remaining.scans === 0;

/** Texte de l'erreur de la dernière analyse, pour la pastille ; null sans erreur. */
export function badgeError(ai: ScanState, locale: Locale): string | null {
	return ai.status === "error" ? aiErrorText(locale, ai.code) : null;
}

/**
 * Clic sur « Analyser » : l'analyse si le compte en a encore, la connexion s'il
 * est déconnecté. Accès inconnu ou déconnecté (R8 : toujours relu), l'accès est
 * d'abord lu, puis l'action suit la réponse. Un accès en erreur, ou sans
 * abonnement d'après la lecture, ouvre le panneau, qui dit pourquoi. La popup de
 * connexion impossible à ouvrir (`loginUnavailable`) ouvre aussi le panneau, qui
 * montre le texte de repli.
 */
export function useLaunch(scan: AiScan, key: string, openPanel: () => void) {
	const { access, loadAccess, login, loginUnavailable } = scan;
	const start = scan.scan;
	// Accès vu au clic, en attente d'une nouvelle lecture ; null sans clic en attente.
	// Chaque lecture donne un objet neuf (clone du message du service worker) : un
	// accès différent de `from` est la réponse attendue. Sans clic, rien n'est lu.
	const pendingRef = useRef<{ from: Access } | null>(null);
	// Connexion demandée depuis la pastille : son échec ouvre le panneau.
	const loginAskedRef = useRef(false);
	const act = useCallback(
		(reading: Access) => {
			if (reading === "loading") return;
			if ("error" in reading || reading.status === "noSubscription")
				openPanel();
			else if (reading.status === "signedOut") {
				loginAskedRef.current = true;
				login();
				// Déjà su impossible : le texte de repli tout de suite.
				if (loginUnavailable) openPanel();
			} else if (reading.remaining.scans !== 0) start();
		},
		[openPanel, login, loginUnavailable, start],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` oublie le clic en attente d'une annonce quittée
	useEffect(() => {
		pendingRef.current = null;
		loginAskedRef.current = false;
	}, [key]);
	useEffect(() => {
		const pending = pendingRef.current;
		if (!pending || access === pending.from || access === "loading") return;
		pendingRef.current = null;
		act(access);
	}, [access, act]);
	useEffect(() => {
		if (!loginUnavailable || !loginAskedRef.current) return;
		loginAskedRef.current = false;
		openPanel();
	}, [loginUnavailable, openPanel]);
	return useCallback(() => {
		if (noScansLeft(access)) return;
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
 * Contrôle de lancement : « Analyser », nommé « Analyser avec l'IA ». Un lien
 * vers les formules sans abonnement ; grisé sans analyse restante, mais
 * focusable, la raison lue avec lui.
 */
function LaunchControl({
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
	const reasonId = useId();
	const label = contentText(locale, "ai.launch");
	const text = contentText(locale, "ai.launchShort");
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
				{text}
			</a>
		);
	}
	const empty = noScansLeft(access);
	const reason = contentText(locale, "ai.noScansLeft");
	return (
		<>
			<button
				type="button"
				aria-label={label}
				aria-disabled={empty ? true : undefined}
				aria-describedby={empty ? reasonId : undefined}
				title={empty ? reason : undefined}
				onClick={onLaunch}
				className={LAUNCH_CLASS}
			>
				{text}
			</button>
			{empty && (
				<span id={reasonId} className="sr-only">
					{reason}
				</span>
			)}
		</>
	);
}

/**
 * La pilule de la fiche, seule à porter un résultat, et toujours celui de l'IA.
 * Selon l'état, dans cet ordre :
 * 1. résultat IA : niveau et score, le clic ouvre ou ferme le panneau ;
 * 2. analyse en cours : l'icône qui tourne et la ligne d'état, même clic ;
 * 3. erreur : son texte (sauf panneau ouvert, qui l'affiche déjà), puis
 *    « Relancer » (analyse coupée en route) ou le contrôle de lancement, ni l'un
 *    ni l'autre si l'accès relu ne laisse plus d'analyse ;
 * 4. repos : le contrôle de lancement.
 * L'analyse locale (règles) n'est jamais affichée : elle part seulement avec la
 * demande, comme contexte pour l'IA.
 */
export function BadgePill({
	scan,
	locale,
	open,
	onToggle,
	onLaunch,
}: {
	scan: AiScan;
	locale: Locale;
	/** Panneau ouvert : l'erreur y est déjà affichée et annoncée. */
	open: boolean;
	onToggle(): void;
	onLaunch(): void;
}) {
	const levelId = useId();
	const scoreId = useId();
	const { ai, access } = scan;
	const shown = shownResult(ai);
	// Analyse en cours : l'icône qui tourne et la ligne d'état du dernier événement.
	const progress = ai.status === "loading" ? ai.progress : null;
	const line = progress ? statusLine(progress, locale) : "";
	const waiting = useWaiting(progress?.lastAt ?? 0, progress !== null);
	// Analyse en échec : son texte dans la pilule et dans la région annoncée,
	// sauf panneau ouvert, qui l'affiche et l'annonce déjà (`role="alert"`).
	const error = open ? null : badgeError(ai, locale);
	const announced = useThrottled(line || error || "");
	const ariaLabel = contentText(locale, "badge.aria");

	let pill: ReactNode;
	if (shown) {
		const style = LEVEL_STYLE[shown.level];
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-label={ariaLabel}
				aria-describedby={`${levelId} ${scoreId}`}
				onClick={onToggle}
				className={TOGGLE_CLASS}
			>
				<span
					aria-hidden="true"
					className={`inline-block size-2.5 rounded-full ${style.dot}`}
				/>
				<span id={levelId} className={style.text}>
					{contentText(locale, LEVEL_KEY[shown.level])}
				</span>
				<span id={scoreId} className="text-slate-600">
					{shown.score}/100
				</span>
			</button>
		);
	} else if (progress) {
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-busy={true}
				aria-label={ariaLabel}
				onClick={onToggle}
				className={TOGGLE_CLASS}
			>
				<Spinner />
				<LiveLine text={line} waiting={waiting} />
			</button>
		);
	} else {
		const launch = (
			<LaunchControl
				access={access}
				locale={locale}
				pricingUrl={scan.pricingUrl}
				onLaunch={onLaunch}
			/>
		);
		if (ai.status !== "error") pill = launch;
		else {
			// Après un échec, plus aucune analyse d'après l'accès relu : le message
			// suffit, jamais un bouton qui ne ferait rien.
			let action: ReactNode = null;
			if (!noScansLeft(access))
				action = RELAUNCH_CODES.has(ai.code) ? (
					<button type="button" onClick={onLaunch} className={LAUNCH_CLASS}>
						{contentText(locale, "ai.retry")}
					</button>
				) : (
					launch
				);
			pill = (
				<>
					{error !== null && (
						<span className="max-w-[260px] text-[12px] font-semibold text-red-800">
							{error}
						</span>
					)}
					{action}
				</>
			);
		}
	}

	return (
		<>
			<span className="inline-flex flex-wrap items-center gap-1.5">{pill}</span>
			{/* Annonces de la ligne d'état : au plus une toutes les 2 s. */}
			<span role="status" aria-live="polite" className="sr-only">
				{announced}
			</span>
		</>
	);
}
