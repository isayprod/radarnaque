import type { Locale } from "@radarnaque/shared";
import { type SyntheticEvent, useId, useState } from "react";
import type { ScanState } from "../lib/content/ai-client";
import type { CardView } from "../lib/content/card-controller";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { LEVEL_KEY, LEVEL_STYLE } from "./risk-styles";

const BUTTON_CLASS =
	"inline-flex h-6 min-w-6 cursor-pointer items-center justify-center gap-1 rounded-full border border-slate-300 bg-white px-1.5 text-[12px] leading-none font-bold text-slate-900 shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";

/**
 * Le site ne doit ni naviguer (carte-lien, clic du milieu compris) ni démarrer
 * un glisser ou un geste tactile depuis l'icône.
 */
const stop = (event: SyntheticEvent) => event.stopPropagation();
const cancel = (event: SyntheticEvent) => {
	event.preventDefault();
	event.stopPropagation();
};

/** Texte de l'infobulle : résumé de l'IA ou message d'erreur ; rien sinon. */
function tooltipText(state: ScanState, locale: Locale): string | null {
	if (state.status === "error") return aiErrorText(locale, state.code);
	if (state.status !== "done") return null;
	const { summary, partial } = state.result;
	return partial
		? `${summary[locale]} ${contentText(locale, "ai.partial")}`
		: summary[locale];
}

function ButtonContent({ state, locale }: Omit<CardView, "onActivate">) {
	if (state.status === "loading") return contentText(locale, "card.loading");
	if (state.status === "done") {
		const style = LEVEL_STYLE[state.result.level];
		return (
			<>
				<span
					aria-hidden="true"
					className={`inline-block size-2 rounded-full ${style.dot}`}
				/>
				<span className={style.text}>
					{contentText(locale, LEVEL_KEY[state.result.level])}
				</span>
			</>
		);
	}
	if (state.status === "error") {
		return (
			<>
				<span>R</span>
				<span className="text-red-700">!</span>
			</>
		);
	}
	return "R";
}

/**
 * Icône Radarnaque d'une carte de résultats. Composant contrôlé : l'état du
 * scan vient du contrôleur de cartes. Le texte de l'IA est rendu en nœuds texte.
 */
export function CardBadge({ state, locale, onActivate }: CardView) {
	const [open, setOpen] = useState(false);
	const tipId = useId();
	const tip = tooltipText(state, locale);
	// Inactif ou en erreur, le clic lance l'analyse : le nom du bouton le dit.
	// Terminé, son nom est le niveau affiché ; en cours, le texte d'attente.
	const label =
		state.status === "idle" || state.status === "error"
			? contentText(locale, "card.aria")
			: undefined;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: le conteneur ne fait qu'arrêter les événements vers la carte-lien, il n'a pas de rôle propre
		<span
			className="radarnaque-root relative ml-1 inline-block align-middle text-[12px] leading-[1.3] font-normal"
			onClick={cancel}
			onAuxClick={cancel}
			onPointerDown={stop}
			onMouseDown={stop}
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
				className={BUTTON_CLASS}
			>
				<ButtonContent state={state} locale={locale} />
			</button>
			{tip !== null && (
				<span
					role="tooltip"
					id={tipId}
					hidden={!open}
					className="absolute top-full left-0 z-[2147483647] mt-1 w-[260px] max-w-[80vw] rounded-[6px] border border-slate-300 bg-white p-2 text-[12px] leading-[1.4] text-slate-900 shadow-lg"
				>
					{tip}
				</span>
			)}
		</span>
	);
}
