import { type RefObject, useLayoutEffect } from "react";

/** Écart gardé entre une couche flottante et les bords de la fenêtre, en px. */
export const VIEW_MARGIN = 8;

/**
 * Décale `element` vers la gauche (`left` négatif) s'il dépasse le bord droit
 * de la fenêtre, jusqu'à `VIEW_MARGIN` du bord, sans jamais passer le bord
 * gauche. Mesuré sans décalage : un décalage devenu inutile est retiré.
 */
function placeInView(element: HTMLElement) {
	element.style.removeProperty("left");
	const { left, right } = element.getBoundingClientRect();
	// Sans la barre de défilement verticale ; `innerWidth` à défaut.
	const viewport = document.documentElement.clientWidth || window.innerWidth;
	const shift = Math.min(right - (viewport - VIEW_MARGIN), left - VIEW_MARGIN);
	if (shift > 0) element.style.left = `${-shift}px`;
}

/**
 * Garde une couche en position absolue (panneau, infobulle), calée à gauche de
 * son ancre, dans la largeur de la fenêtre (`placeInView`). Sans cela, une
 * pastille au bout d'un titre près du bord droit ferait défiler la page hôte
 * horizontalement. Tant que la couche est affichée (`active`), la place est
 * recalculée à chaque rendu du composant (la pilule change de largeur, passe à
 * la ligne et déplace l'ancre) et au redimensionnement de la fenêtre.
 */
export function useKeepInView(
	ref: RefObject<HTMLElement | null>,
	active: boolean,
) {
	// Sans tableau de dépendances : à chaque rendu, avant l'affichage.
	useLayoutEffect(() => {
		if (active && ref.current) placeInView(ref.current);
	});
	useLayoutEffect(() => {
		const element = ref.current;
		if (!active || !element) return;
		const onResize = () => placeInView(element);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			element.style.removeProperty("left");
		};
	}, [ref, active]);
}
