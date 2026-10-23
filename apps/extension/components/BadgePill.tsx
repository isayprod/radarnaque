import type { IdentificationResult, Locale } from "@radarnaque/shared";
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
import { identificationHeadline } from "../lib/content/identification-headline";
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

// Pilule de la fiche, sans largeur maximale : 28 px de haut, texte 13 px.
const BADGE_PILL_BASE_CLASS = `${PILL_CLASS} h-7 min-w-0 gap-2 px-3 text-[13px] leading-none`;

// Pilule de la fiche : au plus 340 px de large (seule la ligne d'état ou le
// message se tronquent).
export const BADGE_PILL_CLASS = `${BADGE_PILL_BASE_CLASS} max-w-[340px]`;

// Pilule « Produit identifié » : au plus 400 px, pour que la référence reste
// lisible à côté du niveau et de « Analyser le risque ».
const PRODUCT_PILL_CLASS = `${BADGE_PILL_BASE_CLASS} max-w-[400px]`;

// Pilule cliquable : repos, analyse en cours, résultat.
export const ACTION_PILL_CLASS = `${BADGE_PILL_CLASS} cursor-pointer hover:border-border-strong aria-disabled:cursor-default aria-disabled:text-text-3 aria-disabled:hover:border-white/12`;

// Action dans la pilule : « Relancer », « Identifier » ou « Analyser le risque »,
// soulignée. Grisée (`aria-disabled`), elle n'est plus soulignée.
export const INLINE_ACTION_CLASS =
	"shrink-0 cursor-pointer rounded-xs text-text-1 underline underline-offset-2 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden aria-disabled:cursor-default aria-disabled:text-text-3 aria-disabled:no-underline";

// Partie produit de la pilule « Produit identifié » : un bouton sans surface
// propre, qui ouvre ou ferme le panneau. Il remplit la hauteur de la pilule et
// reprend son padding gauche (`-ml-3 pl-3`) : une cible de 26 px de haut, sans
// bord mort (WCAG 2.5.8).
const PRODUCT_CLASS =
	"-ml-3 inline-flex min-w-0 cursor-pointer items-center gap-2 self-stretch rounded-l-pill pl-3 text-text-1 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden";

// « Analyser le risque » dans la pilule « Produit identifié » : comme la partie
// produit, toute la hauteur et le padding droit de la pilule.
const PRODUCT_ACTION_CLASS = `${INLINE_ACTION_CLASS} -mr-3 inline-flex items-center self-stretch rounded-r-pill pr-3`;

// Séparateur vertical entre deux parties de la pilule.
const SEPARATOR_CLASS = "h-3.5 w-px shrink-0 bg-white/12";

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
 * Clic sur « Identifier » ou « Analyser le risque » : l'action `start`
 * (`scan.identify` ou `scan.scan`) si le compte a encore une analyse, la connexion s'il est
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
 * le lien vers les formules sans abonnement, sinon l'action de l'étape en échec
 * (« Identifier », « Analyser le risque »). Aucune si l'accès relu ne laisse plus d'analyse (`empty`) :
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
				<span aria-hidden="true" className={SEPARATOR_CLASS} />
			)}
			{action}
		</span>
	);
}

/**
 * Cadre de la pilule de la fiche : le conteneur (`data-pill`, où `focusPill`
 * cherche quoi focaliser), ses descriptions masquées (`hidden`), puis la seule
 * région annoncée de la pastille, sa ligne d'état ou son erreur, au plus une
 * annonce toutes les 2 s (`announced`).
 */
export function PillFrame({
	containerRef,
	children,
	hidden,
	announced,
}: {
	containerRef: RefObject<HTMLSpanElement | null>;
	children: ReactNode;
	hidden?: ReactNode;
	announced: string;
}) {
	return (
		<>
			<span
				ref={containerRef}
				data-pill=""
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
 * Pilule « Produit identifié » (état 5 de `BadgePill`) : la partie produit,
 * bouton qui ouvre ou ferme le panneau (glyphe, référence courte ou « A ou
 * B ? », « · », niveau en toutes lettres ; « Produit non identifié » quand rien
 * n'est identifiable), un séparateur, puis « Analyser le risque ». Le
 * pourcentage reste dans le panneau. Nom accessible de la partie produit :
 * « Identification : » et la référence entière. Aucune couleur sémantique du
 * risque. Au plus 400 px : seule la référence se tronque.
 */
function ProductPill({
	result,
	locale,
	open,
	onToggle,
	onAnalyze,
	pricingUrl,
	disabled,
	describedBy,
	title,
}: {
	result: IdentificationResult;
	locale: Locale;
	open: boolean;
	onToggle(): void;
	onAnalyze(): void;
	/** Sans abonnement : l'action est un lien vers les formules. */
	pricingUrl: string | null;
	/** Grisée (`aria-disabled`) : plus d'analyse, et l'analyse n'est pas incluse. */
	disabled: boolean;
	/** Descriptions de l'action (raison, « Inclus »), rendues par `PillFrame`. */
	describedBy: string | undefined;
	title: string | undefined;
}) {
	const headline = identificationHeadline(result, locale);
	const analyzeText = contentText(locale, "ai.analyzeRisk");
	const label = headline
		? `${headline.reference} · ${headline.level}`
		: contentText(locale, "identify.none");
	// « Identification : Steam Deck OLED · Sûr » : la référence entière.
	const name = contentText(locale, "identify.name").replace(
		"{name}",
		() => label,
	);
	return (
		<span className={PRODUCT_PILL_CLASS}>
			<button
				type="button"
				aria-expanded={open}
				aria-label={name}
				onClick={onToggle}
				className={PRODUCT_CLASS}
			>
				{headline ? (
					<>
						<span data-glyph="" aria-hidden="true" className="shrink-0">
							{headline.glyph}
						</span>
						<span data-reference="" className="min-w-0 truncate">
							{headline.short}
						</span>
						<span aria-hidden="true" className="shrink-0 text-text-3">
							·
						</span>
						<span data-level="" className="shrink-0 text-text-2">
							{headline.level}
						</span>
					</>
				) : (
					<span className="min-w-0 truncate">{label}</span>
				)}
			</button>
			<span aria-hidden="true" className={SEPARATOR_CLASS} />
			{pricingUrl !== null ? (
				<PricingLink
					href={pricingUrl}
					label={analyzeText}
					className={PRODUCT_ACTION_CLASS}
				>
					{analyzeText}
				</PricingLink>
			) : (
				<button
					type="button"
					aria-disabled={disabled ? true : undefined}
					aria-describedby={describedBy}
					title={title}
					onClick={onAnalyze}
					className={PRODUCT_ACTION_CLASS}
				>
					{analyzeText}
				</button>
			)}
		</span>
	);
}

/** Ce que montre la pilule, dans l'ordre de priorité de `pillStep`. */
type PillStep =
	| "restoring"
	| "result"
	| "analyzing"
	| "analysisError"
	| "identified"
	| "identifying"
	| "identificationError"
	| "rest";

/**
 * État affiché par la pilule. L'analyse du risque passe avant l'identification :
 * lancée, elle refait l'identification côté serveur (servie par le cache), et
 * la pilule montre l'analyse en cours, jamais « Identifier ».
 */
function pillStep(scan: AiScan): PillStep {
	const { ai, identification } = scan;
	if (scan.restoring) return "restoring";
	if (shownResult(ai)) return "result";
	if (ai.status === "loading") return "analyzing";
	if (ai.status === "error") return "analysisError";
	if (identification.status === "done") return "identified";
	if (identification.status === "loading") return "identifying";
	if (identification.status === "error") return "identificationError";
	return "rest";
}

/**
 * La pilule unique de la fiche : l'identification, puis l'analyse du risque à
 * la demande. Selon l'état (`pillStep`), dans cet ordre :
 * 1. lecture du magasin des résultats (`restoring`) : rien, pour qu'une fiche
 *    déjà analysée affiche directement son résultat ;
 * 2. résultat du risque : point, niveau, score ; le clic ouvre ou ferme le
 *    panneau ;
 * 3. analyse du risque en cours : le logo animé, « {référence courte} · {ligne
 *    d'état} » (la ligne seule sans référence), même clic ;
 * 4. analyse du risque en échec : le logo atténué, son texte (sauf panneau
 *    ouvert, qui l'affiche déjà), puis « Relancer » (analyse coupée en route) ou
 *    « Analyser le risque » ;
 * 5. produit identifié (`ProductPill`) : glyphe, référence courte (ou « A ou
 *    B ? ») et niveau, sans le pourcentage (dans le panneau), ou « Produit non
 *    identifié », dans un bouton qui ouvre ou ferme le panneau ; un séparateur ;
 *    l'action « Analyser le risque ». Décrite
 *    par « Inclus avec l'identification » quand l'analyse est incluse (alors
 *    acceptée à 0 analyse restante) ; grisée sans inclusion ni analyse
 *    restante, mais focusable, la raison lue avec elle ; un lien vers les
 *    formules sans abonnement ;
 * 6. identification en cours : le logo animé et sa ligne d'état, même clic ;
 * 7. identification en échec : comme l'erreur du risque, l'action étant
 *    « Identifier » (ou « Relancer ») ;
 * 8. repos : le logo et « Identifier », nommé « Identifier le produit » ; un
 *    lien vers les formules sans abonnement ; grisé sans analyse restante.
 * Chaque action passe par `onIdentify` ou `onAnalyze`, qui suivent les règles
 * d'accès de `useLaunch` ; aucune couleur sémantique du risque avant le
 * résultat. Repos et chargements sont un même `<button>` à la même place :
 * lancée au clavier, l'étape garde le focus sur la pilule. Quand l'élément
 * change (produit, erreur, action perdue), `useKeepPillFocus` y remet le focus
 * si la pilule l'avait. L'analyse locale (règles) n'est jamais affichée : elle
 * part seulement avec la demande, comme contexte pour l'IA.
 */
export function BadgePill({
	scan,
	locale,
	open,
	onToggle,
	onIdentify,
	onAnalyze,
	pillRef,
}: {
	scan: AiScan;
	locale: Locale;
	/** Panneau ouvert : l'erreur y est déjà affichée et annoncée. */
	open: boolean;
	onToggle(): void;
	/** « Identifier » et « Relancer » d'une identification en échec. */
	onIdentify(): void;
	/** « Analyser le risque » et « Relancer » d'une analyse en échec. */
	onAnalyze(): void;
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
	const { ai, identification, access, analysisIncluded } = scan;
	const step = pillStep(scan);
	// Étape en cours : le logo animé et la ligne d'état de son dernier événement.
	const progress =
		step === "analyzing" && ai.status === "loading"
			? ai.progress
			: step === "identifying" && identification.status === "loading"
				? identification.progress
				: null;
	const line = !progress
		? ""
		: step === "analyzing"
			? statusLine(progress, locale)
			: statusLine(progress, locale, "identify.start");
	const waiting = useWaiting(progress?.lastAt ?? 0, progress !== null);
	// Étape en échec : son texte dans la pilule et dans la région annoncée, sauf
	// panneau ouvert, qui l'affiche et l'annonce déjà (`role="alert"`).
	const failed =
		step === "analysisError" && ai.status === "error"
			? ai.code
			: step === "identificationError" && identification.status === "error"
				? identification.code
				: null;
	const error = failed !== null && !open ? aiErrorText(locale, failed) : null;
	const announced = useThrottled(line || error || "");
	// Produit identifié : sa référence dans la pilule, et pendant l'analyse du risque.
	const headline =
		identification.status === "done"
			? identificationHeadline(identification.result, locale)
			: null;
	const ariaLabel = contentText(locale, "badge.aria");
	const identifyLabel = contentText(locale, "identify.launch");
	const identifyText = contentText(locale, "identify.launchShort");
	const analyzeText = contentText(locale, "ai.analyzeRisk");
	const emptyIdentify = noScansLeft(access);
	const emptyAnalyze = emptyIdentify && !analysisIncluded;
	const reason = contentText(locale, "ai.noScansLeft");
	const includedText = contentText(locale, "identify.included");
	const noSubscription =
		access !== "loading" &&
		!("error" in access) &&
		access.status === "noSubscription";

	let pill: ReactNode = null;
	// Action grisée : la raison, lue avec elle.
	let disabledReason = false;
	// « Analyser le risque » décrit par « Inclus avec l'identification ».
	let included = false;
	const describedBy = () =>
		[disabledReason ? reasonId : null, included ? includedId : null]
			.filter((id) => id !== null)
			.join(" ") || undefined;

	if (step === "result") {
		const shown = shownResult(ai);
		if (shown) {
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
					<span id={levelId}>
						{contentText(locale, LEVEL_KEY[shown.level])}
					</span>
					<span aria-hidden="true" className={SEPARATOR_CLASS} />
					<span id={scoreId} className="text-text-2 tabular-nums">
						{shown.score}/100
					</span>
				</button>
			);
		}
	} else if (step === "analyzing" || step === "identifying") {
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-busy={true}
				aria-label={ariaLabel}
				onClick={onToggle}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} animated className="shrink-0" />
				{step === "analyzing" && headline && (
					<>
						<span data-reference="" className="min-w-0 truncate">
							{headline.short}
						</span>
						<span aria-hidden="true" className="shrink-0 text-text-3">
							·
						</span>
					</>
				)}
				<LiveLine text={line} waiting={waiting} />
			</button>
		);
	} else if (step === "analysisError" && failed !== null) {
		included = analysisIncluded;
		pill = (
			<ErrorPill
				error={error}
				action={errorAction({
					code: failed,
					empty: emptyAnalyze,
					noSubscription,
					onLaunch: onAnalyze,
					pricingUrl: scan.pricingUrl,
					launchLabel: analyzeText,
					launchText: analyzeText,
					locale,
					describedBy: included ? includedId : undefined,
				})}
			/>
		);
	} else if (step === "identified" && identification.status === "done") {
		if (!noSubscription) {
			disabledReason = emptyAnalyze;
			included = analysisIncluded;
		}
		pill = (
			<ProductPill
				result={identification.result}
				locale={locale}
				open={open}
				onToggle={onToggle}
				onAnalyze={onAnalyze}
				pricingUrl={noSubscription ? scan.pricingUrl : null}
				disabled={emptyAnalyze}
				describedBy={describedBy()}
				title={emptyAnalyze ? reason : included ? includedText : undefined}
			/>
		);
	} else if (step === "identificationError" && failed !== null) {
		pill = (
			<ErrorPill
				error={error}
				action={errorAction({
					code: failed,
					empty: emptyIdentify,
					noSubscription,
					onLaunch: onIdentify,
					pricingUrl: scan.pricingUrl,
					launchLabel: identifyLabel,
					launchText: identifyText,
					locale,
				})}
			/>
		);
	} else if (step === "rest" && noSubscription) {
		pill = (
			<PricingLink
				href={scan.pricingUrl}
				label={identifyLabel}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} className="shrink-0" />
				{identifyText}
			</PricingLink>
		);
	} else if (step === "rest") {
		disabledReason = emptyIdentify;
		pill = (
			<button
				type="button"
				aria-label={identifyLabel}
				aria-disabled={emptyIdentify ? true : undefined}
				aria-describedby={describedBy()}
				title={emptyIdentify ? reason : undefined}
				onClick={onIdentify}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} className="shrink-0" />
				{identifyText}
			</button>
		);
	}

	return (
		<PillFrame
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
