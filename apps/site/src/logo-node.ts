/** Le logo en arbre `h`, à part de layout.ts : /auth/callback l'emploie sans les textes du site. */
import { LOGO } from "@radarnaque/design/logo";
import { h, type VNode } from "./h";

/**
 * Le logo construit depuis `LOGO` : même structure, mêmes attributs et mêmes
 * classes que `logoSvg()` de `@radarnaque/design/logo` (un test les compare).
 * Toujours décoratif : le nom « Radarnaque » est écrit à côté.
 */
export function logoNode(
	options: { animated?: boolean; size?: number } = {},
): VNode {
	const { animated = false, size } = options;
	const { viewBox, center, dotRadius, arcRadius, strokeWidth } = LOGO;
	const c = String(center);
	const arc = h("circle", {
		class: animated ? "rq-logo-arc" : undefined,
		cx: c,
		cy: c,
		r: arcRadius,
		fill: "none",
		stroke: "currentColor",
		"stroke-width": strokeWidth,
		"stroke-linecap": "round",
		pathLength: "360",
		"stroke-dasharray": LOGO.dashArray,
		"stroke-dashoffset": LOGO.dashOffset,
	});
	const dot = h("circle", { cx: c, cy: c, r: dotRadius, fill: "currentColor" });
	return h(
		"svg",
		{
			xmlns: "http://www.w3.org/2000/svg",
			viewBox,
			width: size,
			height: size,
			class: animated ? "rq-logo--loading" : undefined,
			"aria-hidden": "true",
		},
		animated ? [h("g", { class: "rq-logo-spin" }, arc), dot] : [arc, dot],
	);
}
