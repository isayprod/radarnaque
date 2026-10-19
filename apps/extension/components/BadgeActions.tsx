import type { Locale } from "@radarnaque/shared";
import { useCallback, useEffect, useId, useRef } from "react";
import type { ScanState } from "../lib/content/ai-client";
import type { AiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { RELAUNCH_CODES } from "./AiSection";
import { Sparkle } from "./LiveStatus";

type Access = AiScan["access"];

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
 * Clic sur « Analyser avec l'IA » : l'analyse si le compte en a encore, la
 * connexion s'il est déconnecté. Accès inconnu ou déconnecté (R8 : toujours relu),
 * l'accès est d'abord lu, puis l'action suit la réponse. Un accès en erreur, ou
 * sans abonnement d'après la lecture, ouvre le panneau, qui dit pourquoi. La
 * popup de connexion impossible à ouvrir (`loginUnavailable`) ouvre aussi le
 * panneau, qui montre le texte de repli.
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
 * Bouton « Analyser avec l'IA » de la pastille : un lien vers les formules sans
 * abonnement ; grisé sans analyse restante, mais focusable, la raison lue avec lui.
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
	const reasonId = useId();
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
				{content}
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
 * Actions de la pastille à côté du niveau : rien pendant l'analyse ni avec un
 * résultat IA ; après une erreur, son texte, puis « Relancer » (analyse coupée en
 * route) ou le bouton de lancement (rien si l'accès relu ne laisse plus d'analyse) ;
 * sinon le bouton de lancement.
 */
export function BadgeActions({
	scan,
	locale,
	busy,
	onLaunch,
}: {
	scan: AiScan;
	locale: Locale;
	/** Analyse en cours, ou résultat IA affiché. */
	busy: boolean;
	onLaunch(): void;
}) {
	if (busy) return null;
	const { ai, access } = scan;
	const error = badgeError(ai, locale);
	const relaunch = ai.status === "error" && RELAUNCH_CODES.has(ai.code);
	const launch =
		error !== null && noScansLeft(access) ? null : (
			<LaunchButton
				access={access}
				locale={locale}
				pricingUrl={scan.pricingUrl}
				onLaunch={onLaunch}
			/>
		);
	return (
		<>
			{error !== null && (
				<span className="max-w-[260px] text-[12px] font-semibold text-red-800">
					{error}
				</span>
			)}
			{relaunch ? (
				<button type="button" onClick={onLaunch} className={LAUNCH_CLASS}>
					{contentText(locale, "ai.retry")}
				</button>
			) : (
				launch
			)}
		</>
	);
}
