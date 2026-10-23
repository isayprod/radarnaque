import type { Locale } from "@radarnaque/shared";
import {
	type ReactNode,
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
import { shownResult } from "../lib/content/shown-result";
import { useAiScan } from "../lib/content/use-ai-scan";
import { contentText } from "../lib/content-i18n";
import type { DebugLog } from "../lib/debug-log";
import type { Listing } from "../lib/listing/types";
import type { RiskReport } from "../lib/rules/score";
import { AiErrorBoundary } from "./AiErrorBoundary";
import { AiSection, RiskAction } from "./AiSection";
import {
	activeIn,
	BadgePill,
	focusPill,
	noScansLeft,
	useLaunch,
} from "./BadgePill";
import { DebugBoundary, DebugSection } from "./DebugSection";
import { Icon } from "./Icon";
import { IdentificationSection } from "./IdentificationSection";
import { Logo } from "./Logo";
import { LABEL_CLASS } from "./risk-styles";
import { useKeepInView } from "./useKeepInView";

/**
 * Ferme le panneau sur Escape et sur tout clic hors de `ref`, tant qu'il est
 * ouvert. Escape avec le focus dans la pastille (pilule ou panneau) passe par
 * `closeToPill`, qui y rend le focus ; sinon `close`, qui ne le prend pas à la
 * page hôte.
 */
function useDismiss(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	close: () => void,
	closeToPill: () => void,
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
			const active = activeIn(element);
			if (active && element.contains(active)) closeToPill();
			else close();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open, ref, close, closeToPill]);
}

/**
 * Bandeau des annonces professionnelles : une information neutre (encadré
 * `--info-soft`), jamais une alerte. Il s'ajoute au résultat IA, il ne le
 * remplace pas.
 */
function ProNotice({ locale }: { locale: Locale }) {
	return (
		<p
			role="note"
			className="m-0 mb-4 rounded-sm bg-info-soft px-3 py-2 text-[12px] leading-[1.4] text-text-1"
		>
			{contentText(locale, "pro.notice")}
		</p>
	);
}

/**
 * Carte du panneau (spec §3) : verre sombre et flou si disponible, bordure,
 * `--r-m`, ombre des couches flottantes, filet `--gradient-hairline` de 2 px en
 * haut (pseudo-élément : `content` explicite, `@property` étant ignoré dans le
 * shadow root). Pas de bordure en haut : le filet y forme le bord, sans ligne
 * grise au-dessus. 340 px, au plus 90 % de la fenêtre, et décalé vers la gauche
 * s'il dépasserait à droite (`useKeepInView`).
 */
const PANEL_CLASS =
	"absolute top-full left-0 z-[2147483000] mt-1.5 w-[340px] max-w-[90vw] overflow-hidden rounded-md border border-t-0 border-border-default bg-glass-host p-4 text-[13px] leading-[1.45] font-normal text-text-2 shadow-[var(--shadow-float)] supports-[backdrop-filter]:backdrop-blur-[18px] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-[image:var(--gradient-hairline)] before:content-['']";

const CLOSE_CLASS =
	"-my-1 -mr-1.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-pill text-text-2 hover:bg-white/8 hover:text-text-1 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden";

/**
 * Carte du panneau (`PANEL_CLASS`) : en-tête avec le logo, le titre en style
 * `label` qui nomme la boîte de dialogue, et « Fermer ».
 */
function Panel({
	panelRef,
	title,
	locale,
	onClose,
	children,
}: {
	panelRef: RefObject<HTMLDivElement | null>;
	title: string;
	locale: Locale;
	onClose(): void;
	children: ReactNode;
}) {
	const titleId = useId();
	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-labelledby={titleId}
			className={PANEL_CLASS}
		>
			<div className="mb-4 flex items-center gap-2">
				<Logo size={14} className="shrink-0 text-text-1" />
				<h2 id={titleId} className={`${LABEL_CLASS} min-w-0 flex-1 truncate`}>
					{title}
				</h2>
				<button
					type="button"
					aria-label={contentText(locale, "panel.close")}
					onClick={onClose}
					className={CLOSE_CLASS}
				>
					<Icon name="close" size={16} />
				</button>
			</div>
			{children}
		</div>
	);
}

/**
 * « Détail du produit » sous le résultat du risque : un `<details>` natif,
 * fermé par défaut, au clavier (Entrée, Espace) sans code. Le triangle est un
 * simple glyphe qui tourne à l'ouverture.
 */
function ProductDetail({
	locale,
	children,
}: {
	locale: Locale;
	children: ReactNode;
}) {
	return (
		<details className="group mt-4 border-t border-border-subtle pt-3">
			<summary
				className={`${LABEL_CLASS} flex cursor-pointer list-none items-center gap-1.5 rounded-xs hover:text-text-1 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden [&::-webkit-details-marker]:hidden`}
			>
				<span
					aria-hidden="true"
					className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none"
				>
					›
				</span>
				{contentText(locale, "identify.detail")}
			</summary>
			<div className="mt-3">{children}</div>
		</details>
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
	/** Analyse locale (règles) : jamais affichée, envoyée avec la demande comme contexte pour l'IA. */
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
	const pillRef = useRef<HTMLSpanElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	useKeepInView(panelRef, open);
	const close = useCallback(() => setOpen(false), []);
	// « Fermer », ou Escape avec le focus dans la pastille : le focus revient à la
	// pilule (son bouton, son action, ou la pilule d'erreur elle-même), avant que
	// le panneau, qui peut le contenir, ne disparaisse.
	const closeToPill = useCallback(() => {
		focusPill(pillRef.current);
		setOpen(false);
	}, []);
	const openPanel = useCallback(() => setOpen(true), []);
	useDismiss(open, rootRef, close, closeToPill);
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
	// Accès lu au clic sur une action de la pilule (`useLaunch`) ou à l'ouverture
	// du panneau, jamais avant. Panneau ouvert, il est relu au retour sur l'onglet
	// (connexion faite dans la popup) ; `loadAccess` ne fait rien s'il est déjà actif.
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

	// Seul le résultat IA est affiché ; le rapport local ne sert qu'à la demande.
	const shown = shownResult(scan.ai);
	// Section Debug : le serveur a renvoyé `debug` ET l'accès lu est celui du
	// superuser. Un résultat repris du magasin n'a jamais de `debug`.
	const debug =
		shown?.debug &&
		scan.access !== "loading" &&
		!("error" in scan.access) &&
		isDebug(scan.access)
			? shown.debug
			: null;
	// Vendeur déclaré professionnel par le site, ou détecté par l'IA.
	const professional =
		listing.seller.sellerKind === "professional" ||
		shown?.professional === true;

	const key = `${listing.site}|${listing.externalId}`;
	const identify = useLaunch(scan, key, openPanel, scan.identify);
	const analyze = useLaunch(
		scan,
		key,
		openPanel,
		scan.scan,
		scan.analysisIncluded,
	);
	const toggle = useCallback(() => setOpen((value) => !value), []);
	// Contenu du panneau (spec §3), selon l'étape. Chaque écran d'accès
	// (déconnecté, sans abonnement, erreur) n'est montré qu'une fois :
	// - produit pas encore identifié : la section Identification seule ;
	// - identifié, risque pas encore analysé : le produit, puis « Analyser le
	//   risque » (ou ses écrans d'accès, sous le produit) ;
	// - risque analysé : le risque, puis « Détail du produit », replié.
	const identified = scan.identification.status === "done";
	const analyzed = scan.ai.status === "done";
	const noSubscription =
		scan.access !== "loading" &&
		!("error" in scan.access) &&
		scan.access.status === "noSubscription";
	const emptyAnalyze = noScansLeft(scan.access) && !scan.analysisIncluded;
	const identificationSection = (hideRemaining: boolean) => (
		<IdentificationSection
			locale={locale}
			identification={scan.identification}
			access={scan.access}
			onIdentify={() => scan.identify()}
			onLogin={scan.login}
			loginUnavailable={scan.loginUnavailable}
			pricingUrl={scan.pricingUrl}
			hideRemaining={hideRemaining}
		/>
	);
	const aiSection = (
		<AiSection
			locale={locale}
			access={scan.access}
			ai={scan.ai}
			onScan={analyze}
			empty={emptyAnalyze && !noSubscription}
			included={scan.analysisIncluded && !noSubscription}
			onLogin={scan.login}
			loginUnavailable={scan.loginUnavailable}
			pricingUrl={scan.pricingUrl}
		/>
	);
	let content: ReactNode;
	if (analyzed) {
		content = (
			<>
				{aiSection}
				{identified && (
					<ProductDetail locale={locale}>
						{identificationSection(true)}
					</ProductDetail>
				)}
			</>
		);
	} else if (identified) {
		content = (
			<div className="flex flex-col gap-4">
				<section className="flex flex-col gap-2">
					<h3 className={LABEL_CLASS}>
						{contentText(locale, "identify.product")}
					</h3>
					{identificationSection(false)}
				</section>
				<RiskAction
					locale={locale}
					access={scan.access}
					ai={scan.ai}
					onAnalyze={analyze}
					onLogin={scan.login}
					loginUnavailable={scan.loginUnavailable}
					pricingUrl={scan.pricingUrl}
					empty={emptyAnalyze && !noSubscription}
					included={scan.analysisIncluded && !noSubscription}
				/>
			</div>
		);
	} else if (scan.ai.status !== "idle") {
		content = aiSection;
	} else {
		content = identificationSection(false);
	}

	// Police en px et reset explicite : le site hôte ne doit ni agrandir ni styler la pastille.
	return (
		<div
			ref={rootRef}
			className="radarnaque-root relative ml-2 inline-block align-middle text-[13px] leading-[1.4] font-normal"
		>
			<BadgePill
				scan={scan}
				locale={locale}
				open={open}
				onToggle={toggle}
				onIdentify={identify}
				onAnalyze={analyze}
				pillRef={pillRef}
			/>
			{open && (
				<Panel
					panelRef={panelRef}
					title={contentText(locale, "panel.title")}
					locale={locale}
					onClose={closeToPill}
				>
					{professional && <ProNotice locale={locale} />}
					<AiErrorBoundary key={key} locale={locale}>
						{content}
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
				</Panel>
			)}
		</div>
	);
}
