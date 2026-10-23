import type { Locale } from "@radarnaque/shared";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
} from "react";
import type { ScanState } from "../lib/content/ai-client";
import { statusLine } from "../lib/content/scan-progress";
import { shownResult } from "../lib/content/shown-result";
import type { AiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { RELAUNCH_CODES } from "./AiSection";
import { LiveLine, useThrottled, useWaiting } from "./LiveStatus";
import { Logo } from "./Logo";
import { LEVEL_KEY, LEVEL_STYLE } from "./risk-styles";

type Access = AiScan["access"];

/**
 * Surface de la pilule (tableau des valeurs du spec) : verre sombre des pages
 * tierces (`--glass-bg-host`, presque opaque pour le contraste) et flou si
 * disponible, bordure blanche à 12 %, ombre de la pilule primaire, Inter poids 500
 * en blanc, anneau de focus au clavier. Sans taille : chaque usage donne la sienne
 * (28 px pour la fiche, 22 px pour les cartes).
 */
export const PILL_CLASS =
	"inline-flex items-center rounded-pill border border-white/12 bg-glass-host font-sans font-medium whitespace-nowrap text-text-1 no-underline shadow-[var(--shadow-pill)] supports-[backdrop-filter]:backdrop-blur-[18px] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden";

// Pilule de la fiche : 28 px de haut, au plus 340 px de large (seule la ligne
// d'état ou le message se tronquent), texte 13 px.
export const BADGE_PILL_CLASS = `${PILL_CLASS} h-7 max-w-[340px] min-w-0 gap-2 px-3 text-[13px] leading-none`;

// Pilule cliquable : repos, analyse en cours, résultat.
export const ACTION_PILL_CLASS = `${BADGE_PILL_CLASS} cursor-pointer hover:border-border-strong aria-disabled:cursor-default aria-disabled:text-text-3 aria-disabled:hover:border-white/12`;

// Action dans la pilule d'erreur : « Relancer », « Analyser » ou « Identifier », soulignée.
const INLINE_ACTION_CLASS =
	"shrink-0 cursor-pointer rounded-xs text-text-1 underline underline-offset-2 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden";

/**
 * Ce qui reçoit le focus dans la pilule : son bouton ou son lien, l'action de la
 * pilule d'erreur, sinon la pilule d'erreur elle-même (`tabindex="-1"`).
 */
const PILL_FOCUSABLE = "button, a[href], [tabindex]";

/** Donne le focus à la pilule contenue dans `container` ; faux s'il n'y a rien à focaliser. */
export function focusPill(container: HTMLElement | null): boolean {
	const target = container?.querySelector<HTMLElement>(PILL_FOCUSABLE);
	if (!target) return false;
	target.focus();
	return true;
}

/** Élément actif du document ou du shadow root qui contient `element`. */
export function activeIn(element: Element): Element | null {
	const root = element.getRootNode();
	return root instanceof ShadowRoot
		? root.activeElement
		: element.ownerDocument.activeElement;
}

/**
 * Vrai si plus rien n'a le focus dans le document de `element` : seul cas où la
 * pilule le reprend, jamais pris à un autre élément. Le navigateur laisse alors
 * `document.activeElement` sur `body` (null sans `body`), en light DOM comme en
 * Shadow DOM (vu dans Chrome 155). happy-dom, l'environnement des tests, laisse
 * après la suppression de l'élément focalisé d'un shadow root l'hôte actif,
 * avec un `activeElement` null dans le shadow root : c'est aussi un focus
 * perdu. L'hôte de la pastille n'est pas focalisable lui-même : actif, c'est
 * qu'un élément de son arbre a le focus, et le shadow root le donne alors
 * comme `activeElement`.
 */
function focusLost(element: Element): boolean {
	const { activeElement, body } = element.ownerDocument;
	if (activeElement === null || activeElement === body) return true;
	const root = element.getRootNode();
	return (
		root instanceof ShadowRoot &&
		root.activeElement === null &&
		activeElement === root.host
	);
}

/**
 * Garde le focus sur la pilule quand elle change d'élément : le bouton devient
 * une pilule d'erreur (`span`), son action disparaît (accès relu à 0), ou
 * « Relancer » laisse place au bouton de l'analyse en cours. Le navigateur
 * mettrait sinon le focus sur `body`. Seulement si la pilule avait le focus :
 * jamais volé à la page hôte ni au panneau.
 *
 * Quand React retire l'élément focalisé, les navigateurs diffèrent :
 * - Firefox (et happy-dom) suivent le spec : aucun événement. Le dernier
 *   `focusin` laisse `focusedRef` vrai.
 * - Chromium émet `blur` puis `focusout` (qui remonte jusqu'au conteneur) sur
 *   l'élément encore attaché, sans `relatedTarget`, avant de le détacher, en
 *   light DOM comme en Shadow DOM. `focusedRef` repasse à faux ; l'élément est
 *   retenu dans `lostFromRef`, et le trouver détaché au rendu qui suit dit que
 *   c'était une suppression.
 * Un `focusout` sans `relatedTarget` vient aussi d'une fenêtre ou d'un onglet
 * quitté, ou d'un clic hors de tout élément focalisable : l'élément reste
 * attaché, le focus n'est pas repris. La suppression, son `focusout` et l'effet
 * de mise en page ont lieu dans le même commit : l'élément retenu est oublié à
 * la micro-tâche suivante, pour qu'une suppression bien plus tard (fenêtre
 * quittée, où Chromium n'émet plus rien) ne reprenne pas le focus.
 */
export function useKeepPillFocus(container: RefObject<HTMLSpanElement | null>) {
	// Vrai tant que le focus est dans la pilule (et après une suppression sans
	// événement, comme dans Firefox).
	const focusedRef = useRef(false);
	// Élément de la pilule qui a perdu le focus sans `relatedTarget` (Chromium).
	const lostFromRef = useRef<Node | null>(null);
	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const onFocusIn = () => {
			focusedRef.current = true;
			lostFromRef.current = null;
		};
		const onFocusOut = (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (next instanceof Node && element.contains(next)) return;
			focusedRef.current = false;
			const from =
				next === null && event.target instanceof Node ? event.target : null;
			lostFromRef.current = from;
			if (from)
				queueMicrotask(() => {
					if (lostFromRef.current === from) lostFromRef.current = null;
				});
		};
		element.addEventListener("focusin", onFocusIn);
		element.addEventListener("focusout", onFocusOut);
		return () => {
			element.removeEventListener("focusin", onFocusIn);
			element.removeEventListener("focusout", onFocusOut);
		};
	}, [container]);
	// Après chaque rendu : le focus a-t-il quitté une pilule qui l'avait ?
	useLayoutEffect(() => {
		const element = container.current;
		const lost = lostFromRef.current;
		lostFromRef.current = null;
		if (!element) return;
		if (!focusedRef.current && !(lost && !lost.isConnected)) return;
		if (!focusLost(element)) {
			const active = activeIn(element);
			focusedRef.current = active !== null && element.contains(active);
			return;
		}
		focusedRef.current = focusPill(element);
	});
}

/** Plus aucune analyse d'après l'accès lu (quota du plan ou plafond de l'essai). */
export const noScansLeft = (access: Access) =>
	access !== "loading" &&
	!("error" in access) &&
	access.status === "active" &&
	access.remaining.scans === 0;

/** Texte de l'erreur de la dernière analyse, pour la pastille ; null sans erreur. */
export function badgeError(ai: ScanState, locale: Locale): string | null {
	return ai.status === "error" ? aiErrorText(locale, ai.code) : null;
}

/**
 * Clic sur « Analyser » ou « Identifier » : l'action `start` (`scan.scan` ou
 * `scan.identify`) si le compte a encore une analyse, la connexion s'il est
 * déconnecté. `included` : l'action ne compte pas dans le quota (l'analyse
 * incluse avec l'identification, acceptée à 0 analyse restante). Accès inconnu ou déconnecté (R8 : toujours relu), l'accès est
 * d'abord lu, puis l'action suit la réponse. Un accès en erreur, ou sans
 * abonnement d'après la lecture, ouvre le panneau, qui dit pourquoi. La popup de
 * connexion impossible à ouvrir (`loginUnavailable`) ouvre aussi le panneau, qui
 * montre le texte de repli.
 */
export function useLaunch(
	scan: AiScan,
	key: string,
	openPanel: () => void,
	start: () => void,
	included = false,
) {
	const { access, loadAccess, login, loginUnavailable } = scan;
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
			} else if (reading.remaining.scans !== 0 || included) start();
		},
		[openPanel, login, loginUnavailable, start, included],
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
		if (noScansLeft(access) && !included) return;
		if (
			access === "loading" ||
			(!("error" in access) && access.status === "signedOut")
		) {
			pendingRef.current = { from: access };
			loadAccess();
			return;
		}
		act(access);
	}, [access, act, loadAccess, included]);
}

/** Lien vers les formules, à la place de l'action sans abonnement. */
export function PricingLink({
	href,
	label,
	className,
	children,
}: {
	href: string;
	/** Nom accessible : celui de l'action qu'il remplace. */
	label: string;
	className: string;
	children: ReactNode;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={label}
			className={className}
		>
			{children}
		</a>
	);
}

/**
 * Action de la pilule d'erreur : « Relancer » après une requête coupée en route,
 * le lien vers les formules sans abonnement, sinon l'action de repos (« Analyser »,
 * « Identifier »). Aucune si l'accès relu ne laisse plus d'analyse (`empty`) :
 * jamais un bouton qui ne ferait rien.
 */
export function errorAction({
	code,
	empty,
	noSubscription,
	onLaunch,
	pricingUrl,
	launchLabel,
	launchText,
	locale,
	describedBy,
}: {
	code: string;
	empty: boolean;
	noSubscription: boolean;
	onLaunch(): void;
	pricingUrl: string;
	launchLabel: string;
	launchText: string;
	locale: Locale;
	describedBy?: string;
}): ReactNode {
	if (RELAUNCH_CODES.has(code) && !empty)
		return (
			<button type="button" onClick={onLaunch} className={INLINE_ACTION_CLASS}>
				{contentText(locale, "ai.retry")}
			</button>
		);
	if (noSubscription)
		return (
			<PricingLink
				href={pricingUrl}
				label={launchLabel}
				className={INLINE_ACTION_CLASS}
			>
				{launchText}
			</PricingLink>
		);
	if (empty) return null;
	return (
		<button
			type="button"
			aria-label={launchLabel}
			aria-describedby={describedBy}
			onClick={onLaunch}
			className={INLINE_ACTION_CLASS}
		>
			{launchText}
		</button>
	);
}

/**
 * Pilule d'erreur : le logo atténué, le message (`error`, null panneau ouvert),
 * un séparateur et l'action. Sans action, elle peut recevoir le focus elle-même
 * (hors de l'ordre de tabulation) : la fermeture du panneau ou la perte de
 * l'action l'y met. Jamais vide : le logo reste.
 */
export function ErrorPill({
	error,
	action,
}: {
	error: string | null;
	action: ReactNode;
}) {
	return (
		<span
			tabIndex={action === null ? -1 : undefined}
			className={BADGE_PILL_CLASS}
		>
			<Logo size={16} className="shrink-0 opacity-60" />
			{error !== null && (
				<span title={error} className="min-w-0 truncate text-text-2">
					{error}
				</span>
			)}
			{error !== null && action !== null && (
				<span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-white/12" />
			)}
			{action}
		</span>
	);
}

/**
 * Cadre d'une pilule de la fiche : le conteneur (où `focusPill` cherche quoi
 * focaliser), ses descriptions masquées (`hidden`), puis la région annoncée de
 * sa ligne d'état, au plus une annonce toutes les 2 s (`announced`). `name`
 * (`data-pill`) distingue les deux pilules pour la galerie.
 */
export function PillFrame({
	name,
	containerRef,
	children,
	hidden,
	announced,
}: {
	name: "identify" | "analyze";
	containerRef: RefObject<HTMLSpanElement | null>;
	children: ReactNode;
	hidden?: ReactNode;
	announced: string;
}) {
	return (
		<>
			<span
				ref={containerRef}
				data-pill={name}
				className="inline-flex max-w-full items-center align-middle"
			>
				{children}
				{hidden}
			</span>
			<span role="status" aria-live="polite" className="sr-only">
				{announced}
			</span>
		</>
	);
}

/**
 * La pilule « Analyser » de la fiche, seule à porter le résultat de l'analyse,
 * et toujours celui de l'IA. Selon l'état, dans cet ordre :
 * 1. résultat IA : point, niveau, score ; le clic ouvre ou ferme le panneau ;
 * 2. analyse en cours : le logo animé et la ligne d'état, même clic ;
 * 3. analyse en file derrière l'identification (`queued`) : le logo et « En
 *    attente de l'identification… », même clic ;
 * 4. erreur : le logo atténué, son texte (sauf panneau ouvert, qui l'affiche
 *    déjà), puis « Relancer » (analyse coupée en route) ou « Analyser », ni l'un
 *    ni l'autre si l'accès relu ne laisse plus d'analyse ;
 * 5. repos : le logo et « Analyser », nommé « Analyser avec l'IA » ; un lien vers
 *    les formules sans abonnement ; grisé sans analyse restante, mais focusable,
 *    la raison lue avec lui. Après une identification de l'utilisateur, décrit
 *    par « Inclus avec l'identification », et jamais grisé : l'analyse incluse
 *    est acceptée à 0 analyse restante.
 * Repos, analyse en cours et résultat sont un même `<button>` à la même place :
 * lancée au clavier, l'analyse garde le focus sur la pilule. Quand l'élément
 * change (erreur, action perdue, « Relancer »), `useKeepPillFocus` y remet le
 * focus si la pilule l'avait. Une erreur de l'identification ne s'affiche
 * jamais ici : elle est sur la pilule « Identifier ».
 * Rien tant que le magasin des résultats IA n'est pas lu (`restoring`) : une
 * fiche déjà analysée affiche directement son résultat, sans « Analyser » avant.
 * L'analyse locale (règles) n'est jamais affichée : elle part seulement avec la
 * demande, comme contexte pour l'IA.
 */
export function BadgePill({
	scan,
	locale,
	open,
	onToggle,
	onLaunch,
	pillRef,
}: {
	scan: AiScan;
	locale: Locale;
	/** Panneau ouvert : l'erreur y est déjà affichée et annoncée. */
	open: boolean;
	onToggle(): void;
	onLaunch(): void;
	/** Conteneur de la pilule : la fermeture du panneau y rend le focus (`focusPill`). */
	pillRef?: RefObject<HTMLSpanElement | null>;
}) {
	const ownRef = useRef<HTMLSpanElement>(null);
	const containerRef = pillRef ?? ownRef;
	useKeepPillFocus(containerRef);
	const levelId = useId();
	const scoreId = useId();
	const reasonId = useId();
	const includedId = useId();
	const { ai, access, queued, analysisIncluded } = scan;
	const shown = shownResult(ai);
	// Analyse en cours : le logo animé et la ligne d'état du dernier événement.
	const progress = ai.status === "loading" ? ai.progress : null;
	const waitingLine =
		!progress && queued ? contentText(locale, "identify.queued") : "";
	const line = progress ? statusLine(progress, locale) : waitingLine;
	const waiting = useWaiting(progress?.lastAt ?? 0, progress !== null);
	// Analyse en échec : son texte dans la pilule et dans la région annoncée,
	// sauf panneau ouvert, qui l'affiche et l'annonce déjà (`role="alert"`).
	const error = open ? null : badgeError(ai, locale);
	const announced = useThrottled(line || error || "");
	const ariaLabel = contentText(locale, "badge.aria");
	const launchLabel = contentText(locale, "ai.launch");
	const launchText = contentText(locale, "ai.launchShort");
	const empty = noScansLeft(access) && !analysisIncluded;
	const reason = contentText(locale, "ai.noScansLeft");
	const includedText = contentText(locale, "identify.included");
	const noSubscription =
		access !== "loading" &&
		!("error" in access) &&
		access.status === "noSubscription";

	let pill: ReactNode = null;
	// Pilule de repos grisée : la raison, lue avec elle.
	let disabledReason = false;
	// « Analyser » décrit par « Inclus avec l'identification ».
	let included = false;
	if (scan.restoring) {
		// Lecture du magasin en cours : rien à cliquer.
	} else if (shown) {
		const style = LEVEL_STYLE[shown.level];
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-label={ariaLabel}
				aria-describedby={`${levelId} ${scoreId}`}
				onClick={onToggle}
				className={ACTION_PILL_CLASS}
			>
				<span
					aria-hidden="true"
					className={`size-2 shrink-0 rounded-full ${style.dot}`}
				/>
				<span id={levelId}>{contentText(locale, LEVEL_KEY[shown.level])}</span>
				<span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-white/12" />
				<span id={scoreId} className="text-text-2 tabular-nums">
					{shown.score}/100
				</span>
			</button>
		);
	} else if (progress || queued) {
		// En file, rien ne tourne encore : le logo reste immobile.
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-busy={true}
				aria-label={ariaLabel}
				onClick={onToggle}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} animated={progress !== null} className="shrink-0" />
				<LiveLine text={line} waiting={waiting} />
			</button>
		);
	} else if (ai.status === "error") {
		included = analysisIncluded;
		pill = (
			<ErrorPill
				error={error}
				action={errorAction({
					code: ai.code,
					empty,
					noSubscription,
					onLaunch,
					pricingUrl: scan.pricingUrl,
					launchLabel,
					launchText,
					locale,
					describedBy: included ? includedId : undefined,
				})}
			/>
		);
	} else if (noSubscription) {
		pill = (
			<PricingLink
				href={scan.pricingUrl}
				label={launchLabel}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} className="shrink-0" />
				{launchText}
			</PricingLink>
		);
	} else {
		disabledReason = empty;
		included = analysisIncluded;
		const describedBy = [
			empty ? reasonId : null,
			included ? includedId : null,
		].filter((id) => id !== null);
		pill = (
			<button
				type="button"
				aria-label={launchLabel}
				aria-disabled={empty ? true : undefined}
				aria-describedby={describedBy.join(" ") || undefined}
				title={empty ? reason : included ? includedText : undefined}
				onClick={onLaunch}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} className="shrink-0" />
				{launchText}
			</button>
		);
	}

	return (
		<PillFrame
			name="analyze"
			containerRef={containerRef}
			announced={announced}
			hidden={
				<>
					{disabledReason && (
						<span id={reasonId} className="sr-only">
							{reason}
						</span>
					)}
					{included && (
						<span id={includedId} className="sr-only">
							{includedText}
						</span>
					)}
				</>
			}
		>
			{pill}
		</PillFrame>
	);
}
