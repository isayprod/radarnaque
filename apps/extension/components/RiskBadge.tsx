import type { Locale } from "@radarnaque/shared";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { AccessCache } from "../lib/content/access-policy";
import type { AiClient } from "../lib/content/ai-client";
import type { AiResultStore } from "../lib/content/ai-results";
import { useAiScan } from "../lib/content/use-ai-scan";
import { contentText, signalText } from "../lib/content-i18n";
import type { Listing } from "../lib/listing/types";
import type { Severity, Signal } from "../lib/rules/rules";
import type { RiskReport } from "../lib/rules/score";
import { AiErrorBoundary } from "./AiErrorBoundary";
import { AiSection } from "./AiSection";
import { LEVEL_KEY, LEVEL_STYLE, SEVERITY_STYLE } from "./risk-styles";

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

export function RiskBadge({
	report,
	listing,
	locale,
	ai,
	accessCache,
	aiResults,
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
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const levelId = useId();
	const scoreId = useId();
	const close = useCallback(() => setOpen(false), []);
	useDismiss(open, rootRef, close);
	// L'état IA vit ici, pas dans le panneau : il survit à sa fermeture.
	const scan = useAiScan(
		ai,
		{ report, listing },
		locale,
		accessCache,
		aiResults,
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

	const style = LEVEL_STYLE[report.level];
	const signals = [...report.signals].sort(byGravity);

	// Police en px et reset explicite : le site hôte ne doit ni agrandir ni styler la pastille.
	return (
		<div
			ref={rootRef}
			className="radarnaque-root relative ml-2 inline-block align-middle text-[13px] leading-[1.4] font-normal"
		>
			<button
				type="button"
				aria-expanded={open}
				aria-label={contentText(locale, "badge.aria")}
				aria-describedby={`${levelId} ${scoreId}`}
				onClick={() => setOpen((value) => !value)}
				className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[13px] leading-[1.4] font-semibold shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
			>
				<span
					aria-hidden="true"
					className={`inline-block size-2.5 rounded-full ${style.dot}`}
				/>
				<span id={levelId} className={style.text}>
					{contentText(locale, LEVEL_KEY[report.level])}
				</span>
				<span id={scoreId} className="text-slate-600">
					{report.score}/100
				</span>
			</button>
			{open && (
				<div
					role="dialog"
					aria-label={contentText(locale, "panel.title")}
					className="absolute top-full left-0 z-[2147483647] mt-1.5 w-[320px] max-w-[90vw] rounded-[8px] border border-slate-300 bg-white p-3 text-[13px] leading-[1.4] text-slate-900 shadow-lg"
				>
					<h2 className="m-0 mb-2 text-[14px] font-bold">
						{contentText(locale, "panel.title")}
					</h2>
					{signals.length === 0 ? (
						<p className="m-0">{contentText(locale, "panel.none")}</p>
					) : (
						<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
							{signals.map((signal) => (
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
					)}
					<AiErrorBoundary
						key={`${listing.site}|${listing.externalId}`}
						locale={locale}
					>
						<AiSection
							locale={locale}
							access={scan.access}
							hasPhotos={listing.images.length > 0}
							text={scan.text}
							image={scan.image}
							onScan={scan.scan}
							onLogin={scan.login}
							loginUnavailable={scan.loginUnavailable}
							pricingUrl={scan.pricingUrl}
						/>
					</AiErrorBoundary>
					<p className="m-0 mt-3 border-t border-slate-200 pt-2 text-[12px] text-slate-600">
						{contentText(locale, "panel.footer")}
					</p>
				</div>
			)}
		</div>
	);
}
