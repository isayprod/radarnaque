/**
 * Icônes Lucide (licence ISC) utilisées par l'interface : fermer, chevron, relancer.
 * Grille 24, trait 1,5, couleur `currentColor` (DESIGN.md §2.7).
 */
export type IconElement = { readonly tag: "path"; readonly d: string };

export const ICON_VIEWBOX = "0 0 24 24";
export const ICON_STROKE_WIDTH = 1.5;

export const ICONS = {
	close: [
		{ tag: "path", d: "M18 6 6 18" },
		{ tag: "path", d: "m6 6 12 12" },
	],
	chevronDown: [{ tag: "path", d: "m6 9 6 6 6-6" }],
	rotateCcw: [
		{ tag: "path", d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" },
		{ tag: "path", d: "M3 3v5h5" },
	],
} as const satisfies Record<string, readonly IconElement[]>;
