import type { Locale } from "@radarnaque/shared";
import { type SyntheticEvent, useId, useRef, useState } from "react";
import type { ScanState } from "../lib/content/ai-client";
import type { CardView } from "../lib/content/card-controller";
import { statusLine } from "../lib/content/scan-progress";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { PILL_CLASS } from "./BadgePill";
import { Logo } from "./Logo";
import { CARD_LEVEL_KEY, LEVEL_KEY, LEVEL_STYLE } from "./risk-styles";
import { useKeepInView } from "./useKeepInView";

/**
 * Mini-pilule (spec §4) : la surface de la pilule de la fiche, 22 px de haut,
 * Inter 11 px poids 500. Au repos et pendant l'analyse, le logo seul dans un
 * carré de 22 × 22 ; avec un niveau ou une erreur, elle s'élargit.
 */
const BUTTON_CLASS = `${PILL_CLASS} h-[22px] min-w-[22px] cursor-pointer justify-center gap-1 text-[11px] leading-none hover:border-border-strong`;
const SQUARE_CLASS = "w-[22px] px-0";
const WIDE_CLASS = "px-2";

/**
 * Infobulle : verre sombre, `--r-s`, 260 px, texte 12 px, au-dessus de la page,
 * décalée vers la gauche si elle dépasserait à droite (`useKeepInView`).
 */
const TOOLTIP_CLASS =
	"absolute top-full left-0 z-[2147483000] mt-1 w-[260px] max-w-[80vw] rounded-sm border border-border-default bg-glass-host p-2 font-sans text-[12px] leading-[1.4] whitespace-normal text-text-1 shadow-[var(--shadow-float)] supports-[backdrop-filter]:backdrop-blur-[18px]";

/**
 * Le site ne doit ni naviguer (carte-lien, clic du milieu compris) ni démarrer
 * un glisser ou un geste tactile depuis l'icône.
 */
const stop = (event: SyntheticEvent) => event.stopPropagation();
const cancel = (event: SyntheticEvent) => {
	event.preventDefault();
	event.stopPropagation();
};

/**
 * Contenu de l'infobulle : la ligne d'état en direct pendant l'analyse, puis le
 * résumé de l'IA ou le message d'erreur ; rien sinon. `professional` ajoute
 * `pro.notice` sous le résumé.
 */
function tooltipOf(
	state: ScanState,
	locale: Locale,
): { text: string; professional: boolean } | null {
	if (state.status === "loading")
		return { text: statusLine(state.progress, locale), professional: false };
	if (state.status === "error")
		return { text: aiErrorText(locale, state.code), professional: false };
	if (state.status !== "done") return null;
	const { summary, partial, professional } = state.result;
	const text = partial
		? `${summary[locale]} ${contentText(locale, "ai.partial")}`
		: summary[locale];
	return { text, professional };
}

function ButtonContent({ state, locale }: Omit<CardView, "onActivate">) {
	// Le logo tourne ; le texte d'attente reste le nom du bouton.
	if (state.status === "loading") {
		return (
			<>
				<Logo size={13} animated className="shrink-0" />
				<span className="sr-only">{contentText(locale, "card.loading")}</span>
			</>
		);
	}
	// Le niveau court est visible ; le nom du bouton garde le niveau complet.
	if (state.status === "done") {
		const { level } = state.result;
		return (
			<>
				<span
					aria-hidden="true"
					className={`size-1.5 shrink-0 rounded-full ${LEVEL_STYLE[level].dot}`}
				/>
				<span>{contentText(locale, CARD_LEVEL_KEY[level])}</span>
			</>
		);
	}
	if (state.status === "error") {
		return (
			<>
				<Logo size={13} className="shrink-0 opacity-60" />
				<span className="font-semibold text-danger">!</span>
			</>
		);
	}
	return <Logo size={13} className="shrink-0" />;
}

/**
 * Icône Radarnaque d'une carte de résultats. Composant contrôlé : l'état du
 * scan vient du contrôleur de cartes. Le texte de l'IA est rendu en nœuds texte.
 */
export function CardBadge({ state, locale, onActivate }: CardView) {
	const [open, setOpen] = useState(false);
	const tipId = useId();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const tipRef = useRef<HTMLSpanElement>(null);
	// `preventDefault` sur l'appui : la carte-lien ne peut pas démarrer un
	// glisser depuis l'icône. Il retire aussi le focus par défaut du bouton,
	// rendu ici à la main.
	const press = (event: SyntheticEvent) => {
		cancel(event);
		const button = buttonRef.current;
		if (button && event.target instanceof Node && button.contains(event.target))
			button.focus({ preventScroll: true });
	};
	const tip = tooltipOf(state, locale);
	useKeepInView(tipRef, open && tip !== null);
	// Inactif ou en erreur, le clic lance l'analyse : le nom du bouton le dit.
	// Terminé, son nom est le niveau complet (le texte visible est le niveau
	// court) ; en cours, le texte d'attente, et l'infobulle suit la ligne d'état.
	const label =
		state.status === "done"
			? contentText(locale, LEVEL_KEY[state.result.level])
			: state.status === "loading"
				? undefined
				: contentText(locale, "card.aria");
	const square = state.status === "idle" || state.status === "loading";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: le conteneur ne fait qu'arrêter les événements vers la carte-lien, il n'a pas de rôle propre
		<span
			className="radarnaque-root relative ml-1 inline-block align-middle text-[12px] leading-[1.3] font-normal"
			onClick={cancel}
			onAuxClick={cancel}
			onPointerDown={press}
			onMouseDown={press}
			onPointerUp={stop}
			onMouseUp={stop}
			onTouchEnd={stop}
			onDragStart={cancel}
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onKeyDown={(event) => {
				if (event.key === "Escape") setOpen(false);
				// Entrée et Espace activent le bouton, pas la carte-lien.
				if (event.key === "Enter" || event.key === " ") event.stopPropagation();
			}}
		>
			<button
				ref={buttonRef}
				type="button"
				draggable={false}
				aria-label={label}
				aria-busy={state.status === "loading" ? true : undefined}
				aria-describedby={tip ? tipId : undefined}
				onClick={(event) => {
					cancel(event);
					onActivate();
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				className={`${BUTTON_CLASS} ${square ? SQUARE_CLASS : WIDE_CLASS}`}
			>
				<ButtonContent state={state} locale={locale} />
			</button>
			{tip !== null && (
				<span
					ref={tipRef}
					role="tooltip"
					id={tipId}
					hidden={!open}
					className={TOOLTIP_CLASS}
				>
					<span className="block">{tip.text}</span>
					{tip.professional && (
						<span className="mt-1 block border-t border-border-subtle pt-1 text-text-2">
							{contentText(locale, "pro.notice")}
						</span>
					)}
				</span>
			)}
		</span>
	);
}
