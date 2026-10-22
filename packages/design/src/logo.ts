/**
 * Logo de Radarnaque (DESIGN.md §2.7) : un point plein au centre d'un arc de 240°,
 * sur une grille de 32 x 32. Le SVG est toujours en ligne : une animation CSS
 * n'atteint pas l'intérieur d'un `<use>`.
 */
export const LOGO = {
	viewBox: "0 0 32 32",
	center: 16,
	dotRadius: 4,
	arcRadius: 10,
	strokeWidth: 3.2,
	dashArray: "240 120",
	dashOffset: -15,
} as const;

/**
 * Copie de `--grad-1`, `--grad-2` et `--grad-3` de tokens.css : resvg ignore les variables CSS.
 * Un test vérifie que les deux restent identiques.
 */
export const GRADIENT_COMPACT = [
	["#0649b8", 0],
	["#4e8fe8", 0.6],
	["#c7b9ec", 1],
] as const;

export type LogoOptions = {
	/** Ajoute les classes de l'animation de chargement (motion.css). */
	animated?: boolean;
	/** Taille en pixels ; sans valeur, le SVG prend la taille de son conteneur. */
	size?: number;
	/** Nom accessible ; sans valeur, le logo est décoratif (`aria-hidden`). */
	label?: string;
};

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Nombre sans bruit de flottant (0.375, 2.48). */
function num(value: number): string {
	return String(Math.round(value * 10000) / 10000);
}

/** Éléments du logo (point et arc), sans balise `<svg>`. */
function logoBody(animated: boolean): string {
	const { center, dotRadius, arcRadius, strokeWidth, dashArray, dashOffset } =
		LOGO;
	const dot = `<circle cx="${center}" cy="${center}" r="${dotRadius}" fill="currentColor"/>`;
	const arc =
		`<circle${animated ? ' class="rq-logo-arc"' : ""} cx="${center}" cy="${center}" r="${arcRadius}"` +
		` fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round"` +
		` pathLength="360" stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}"/>`;
	return animated ? `<g class="rq-logo-spin">${arc}</g>${dot}` : `${arc}${dot}`;
}

export function logoSvg(options: LogoOptions = {}): string {
	const { animated = false, size, label } = options;
	const attrs = [
		'xmlns="http://www.w3.org/2000/svg"',
		`viewBox="${LOGO.viewBox}"`,
		...(size === undefined ? [] : [`width="${size}"`, `height="${size}"`]),
		...(animated ? ['class="rq-logo--loading"'] : []),
		...(label === undefined ? ['aria-hidden="true"'] : ['role="img"']),
	];
	const title = label === undefined ? "" : `<title>${escapeXml(label)}</title>`;
	return `<svg ${attrs.join(" ")}>${title}${logoBody(animated)}</svg>`;
}

/** Part du logo dans la tuile : 75 % à 16 px, 62 % au-delà. */
function logoShare(size: number): number {
	return size <= 16 ? 0.75 : 0.62;
}

/**
 * Tuile de l'icône (extension, favicon) : carré à coins arrondis (22 %) rempli de
 * `--gradient-compact` (160°), avec le logo blanc centré.
 */
export function iconTileSvg(size: number): string {
	const scale = (size * logoShare(size)) / 32;
	const offset = (size - 32 * scale) / 2;
	// Dégradé CSS à 160° : la ligne passe par le centre, sa longueur couvre le carré.
	const angle = (160 * Math.PI) / 180;
	const dx = Math.sin(angle);
	const dy = -Math.cos(angle);
	const half = (size * (Math.abs(dx) + Math.abs(dy))) / 2;
	const c = size / 2;
	const stops = GRADIENT_COMPACT.map(
		([color, at]) => `<stop offset="${at}" stop-color="${color}"/>`,
	).join("");
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
		`<defs><linearGradient id="rq-tile" gradientUnits="userSpaceOnUse"` +
		` x1="${num(c - dx * half)}" y1="${num(c - dy * half)}" x2="${num(c + dx * half)}" y2="${num(c + dy * half)}">` +
		`${stops}</linearGradient></defs>` +
		`<rect width="${size}" height="${size}" rx="${num(size * 0.22)}" fill="url(#rq-tile)"/>` +
		`<g color="#ffffff" transform="translate(${num(offset)} ${num(offset)}) scale(${num(scale)})">` +
		`${logoBody(false)}</g></svg>`
	);
}
