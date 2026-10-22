import type { Locale } from "@radarnaque/shared";
import {
	type RefObject,
	useCallback,
	useEffect,
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
import { AiSection } from "./AiSection";
import { BadgePill, useLaunch } from "./BadgePill";
import { DebugBoundary, DebugSection } from "./DebugSection";

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

/**
 * Bandeau des annonces professionnelles : une information neutre (ardoise),
 * jamais une alerte. Il s'ajoute au résultat IA, il ne le remplace pas.
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
	// Accès lu au clic sur « Analyser » (`useLaunch`) ou à l'ouverture du panneau,
	// jamais avant. Panneau ouvert, il est relu
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

	// Seul le résultat IA est affiché ; le rapport local ne sert qu'à la demande.
	const shown = shownResult(scan.ai);
	const title = contentText(locale, "panel.title");
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

	const launch = useLaunch(
		scan,
		`${listing.site}|${listing.externalId}`,
		openPanel,
	);
	const toggle = useCallback(() => setOpen((value) => !value), []);

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
				onLaunch={launch}
			/>
			{open && (
				<div
					role="dialog"
					aria-label={title}
					className="absolute top-full left-0 z-[2147483647] mt-1.5 w-[320px] max-w-[90vw] rounded-[8px] border border-slate-300 bg-white p-3 text-[13px] leading-[1.4] text-slate-900 shadow-lg"
				>
					{professional && <ProNotice locale={locale} />}
					<h2 className="m-0 mb-2 text-[14px] font-bold">{title}</h2>
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
				</div>
			)}
		</div>
	);
}
