import {
	ICON_STROKE_WIDTH,
	ICON_VIEWBOX,
	ICONS,
} from "@radarnaque/design/icons";

/**
 * Icône Lucide du paquet design, en SVG en ligne, décorative : le nom accessible
 * est porté par le bouton qui la contient. Trait 1,5, couleur `currentColor`.
 */
export function Icon({
	name,
	size,
	className,
}: {
	name: keyof typeof ICONS;
	size: number;
	className?: string;
}) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={ICON_VIEWBOX}
			width={size}
			height={size}
			fill="none"
			stroke="currentColor"
			strokeWidth={ICON_STROKE_WIDTH}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			{ICONS[name].map((element) => (
				<path key={element.d} d={element.d} />
			))}
		</svg>
	);
}
