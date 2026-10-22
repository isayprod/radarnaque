import { type RefObject, useLayoutEffect } from "react";

/** Écart gardé entre une couche flottante et les bords de la fenêtre, en px. */
export const VIEW_MARGIN = 8;

/**
 * Garde une couche en position absolue (panneau, infobulle), calée à gauche de
 * son ancre, dans la largeur de la fenêtre : si elle déborde à droite, elle est
 * décalée vers la gauche (`left` négatif) jusqu'à `VIEW_MARGIN` du bord, sans
 * jamais passer le bord gauche. Sans cela, une pastille au bout d'un titre près
 * du bord droit ferait défiler la page hôte horizontalement. Recalculé au
 * redimensionnement de la fenêtre, tant que la couche est affichée (`active`).
 */
export function useKeepInView(
	ref: RefObject<HTMLElement | null>,
	active: boolean,
) {
	useLayoutEffect(() => {
		const element = ref.current;
		if (!active || !element) return;
		const place = () => {
			element.style.removeProperty("left");
			const { left, right } = element.getBoundingClientRect();
			// Sans la barre de défilement verticale ; `innerWidth` à défaut.
			const viewport =
				document.documentElement.clientWidth || window.innerWidth;
			const shift = Math.min(
				right - (viewport - VIEW_MARGIN),
				left - VIEW_MARGIN,
			);
			if (shift > 0) element.style.left = `${-shift}px`;
		};
		place();
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("resize", place);
			element.style.removeProperty("left");
		};
	}, [ref, active]);
}
