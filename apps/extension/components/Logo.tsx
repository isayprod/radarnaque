import { LOGO } from "@radarnaque/design/logo";

/**
 * Logo de Radarnaque en SVG en ligne (même structure que `logoSvg` du paquet
 * design), décoratif. `animated` ajoute les classes de l'animation de chargement
 * (motion.css) : l'arc seul dans le groupe tournant, le point en dehors, aucun
 * attribut `transform`. Sous `prefers-reduced-motion`, il reste dans sa forme de repos.
 */
export function Logo({
	size,
	animated = false,
	className,
}: {
	size: number;
	animated?: boolean;
	className?: string;
}) {
	const { center, dotRadius, arcRadius, strokeWidth, dashArray, dashOffset } =
		LOGO;
	const classes = [animated ? "rq-logo--loading" : "", className ?? ""]
		.filter(Boolean)
		.join(" ");
	const arc = (
		<circle
			className={animated ? "rq-logo-arc" : undefined}
			cx={center}
			cy={center}
			r={arcRadius}
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			pathLength={360}
			strokeDasharray={dashArray}
			strokeDashoffset={dashOffset}
		/>
	);
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={LOGO.viewBox}
			width={size}
			height={size}
			aria-hidden="true"
			className={classes || undefined}
		>
			{animated ? <g className="rq-logo-spin">{arc}</g> : arc}
			<circle cx={center} cy={center} r={dotRadius} fill="currentColor" />
		</svg>
	);
}
