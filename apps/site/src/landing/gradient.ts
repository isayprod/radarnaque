/**
 * Dégradé de la landing qui suit le scroll (spec landing §5.1) : un calque fixe
 * porte cinq arrêts `--s1` à `--s5` ; leurs couleurs passent du dégradé du hero
 * (p = 0) au crépuscule, à la nuit, puis à une lueur d'horizon orange sourde au
 * pied de page (p = 1). Interpolation dans l'espace OKLab, lissage `smoothstep`
 * entre deux palettes clés, sans dépendance.
 *
 * Les clés après le hero sont celles du spec, rendues plus colorées (règle 8 du
 * contrôleur : bleu → violet → prune → orange sourd) pour que le changement se
 * voie en défilant, sans jamais laisser au `--text-2` moins de 4,5:1 (test).
 */

export type Palette = readonly [string, string, string, string, string];

/** Fin du hero dans la progression du scroll (spec §5.1) : contraste garanti au-delà. */
export const HERO_END = 0.15;

// palettes clés : début (couleurs brutes admises par le garde-fou des tokens)
/**
 * Palettes clés, du haut de la page (p = 0) au pied de page (p = 1). p = 0 : le
 * dégradé du hero (`--grad-1` à `--grad-5`), identique au hero sans JavaScript.
 */
export const PALETTE_KEYS: readonly { p: number; colors: Palette }[] = [
	// Hero : cobalt, bleu ciel, lilas, pêche, orange.
	{ p: 0, colors: ["#0649b8", "#4e8fe8", "#c7b9ec", "#ffd4ad", "#e16c3f"] },
	// Le jour tombe : navy en haut, le bleu descendu en bas, déjà teinté de violet
	// (indigo plutôt que le cobalt #0b3a8c du spec : écart de rouge réduit depuis la
	// pêche, pour que la transition du hero reste continue, test à l'appui).
	{
		p: HERO_END,
		colors: ["#020b2d", "#031033", "#06215f", "#3d369c", "#33297e"],
	},
	// Crépuscule : le bleu vire au violet.
	{
		p: 0.35,
		colors: ["#020b2d", "#04103a", "#121a5e", "#2a2382", "#43278a"],
	},
	// La nuit : navy profond, un reste de lilas tourné prune tout en bas.
	{
		p: 0.6,
		colors: ["#020b2d", "#020b2d", "#08133f", "#1e1a52", "#4a2160"],
	},
	// Pied de page : lueur d'horizon orange sourde qui remonte sous le navy.
	{
		p: 1,
		colors: ["#020b2d", "#031033", "#14143e", "#40193f", "#6e2e22"],
	},
];
// palettes clés : fin

type Rgb = [number, number, number];
type Lab = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Lissage d'Hermite : pente nulle aux deux bouts, aucun saut de vitesse aux clés. */
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Canaux 0-1 d'une couleur `#rrggbb` ou de sa forme fonctionnelle, et son alpha. */
function parseColor(color: string): { rgb: Rgb; alpha: number } {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
	if (hex)
		return {
			rgb: [hex[1], hex[2], hex[3]].map(
				(c) => Number.parseInt(c ?? "0", 16) / 255,
			) as Rgb,
			alpha: 1,
		};
	const fn =
		/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
			color.trim(),
		);
	if (fn)
		return {
			rgb: [fn[1], fn[2], fn[3]].map((c) => Number(c) / 255) as Rgb,
			alpha: fn[4] === undefined ? 1 : Number(fn[4]),
		};
	throw new Error(`Couleur illisible : ${color}`);
}

const toHex = (rgb: Rgb) =>
	`#${rgb
		.map((c) =>
			Math.round(clamp01(c) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;

/** sRGB (0-1) vers linéaire, et retour. */
const toLinear = (c: number) =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const fromLinear = (c: number) =>
	c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

/** sRGB vers OKLab (Björn Ottosson, 2020). */
function toOklab(rgb: Rgb): Lab {
	const [r, g, b] = rgb.map(toLinear) as Rgb;
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** OKLab vers sRGB (0-1, borné au gamut). */
function fromOklab([L, a, b]: Lab): Rgb {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	].map((c) => clamp01(fromLinear(clamp01(c)))) as Rgb;
}

/** Palettes clés en OKLab, calculées une fois. */
const KEYS_LAB = PALETTE_KEYS.map((key) => ({
	p: key.p,
	colors: key.colors.map((c) => toOklab(parseColor(c).rgb)),
}));

/**
 * Les cinq couleurs du dégradé à la progression `p` (bornée à [0, 1]), en
 * `#rrggbb` : entre deux clés, interpolation OKLab lissée par `smoothstep`.
 */
export function paletteAt(p: number): [string, string, string, string, string] {
	const x = Number.isNaN(p) ? 0 : clamp01(p);
	const i = PALETTE_KEYS.findIndex((key) => key.p >= x);
	const exact = PALETTE_KEYS[i];
	if (exact && (exact.p === x || i === 0))
		return [...exact.colors] as [string, string, string, string, string];
	const a = KEYS_LAB[i - 1];
	const b = KEYS_LAB[i];
	if (!a || !b) throw new Error(`Palette introuvable pour p = ${p}`);
	const t = smoothstep((x - a.p) / (b.p - a.p));
	return a.colors.map((from, n) => {
		const to = b.colors[n] ?? from;
		return toHex(
			fromOklab(from.map((v, c) => v + ((to[c] ?? v) - v) * t) as Lab),
		);
	}) as [string, string, string, string, string];
}

/** Luminance relative WCAG 2 d'une couleur opaque (canaux 0-1). */
const luminance = (rgb: Rgb) => {
	const [r, g, b] = rgb.map(toLinear) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * Rapport de contraste WCAG 2 entre un premier plan (alpha composé sur le fond,
 * comme le navigateur le peint) et un fond opaque.
 */
export function contrastRatio(foreground: string, background: string): number {
	const fg = parseColor(foreground);
	const bg = parseColor(background).rgb;
	const painted = fg.rgb.map(
		(c, i) => c * fg.alpha + (bg[i] ?? 0) * (1 - fg.alpha),
	) as Rgb;
	const [hi, lo] = [luminance(painted), luminance(bg)].sort((x, y) => y - x);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/**
 * Progression du scroll, de 0 (haut) à 1 (bas, `max` = hauteur défilable).
 * `anchor` est la position où le hero s'achève (le contenu qui suit entre dans
 * la fenêtre) : elle vaut `HERO_END`, pour que le contraste soit garanti dès que
 * le texte des sections est visible, quelle que soit la hauteur de la fenêtre.
 * Linéaire par morceaux de part et d'autre ; `smoothstep` à la clé efface le coude.
 */
export function scrollProgress(
	scrollY: number,
	max: number,
	anchor: number,
): number {
	if (!(max > 0)) return 0;
	const y = Math.min(Math.max(scrollY, 0), max);
	const a = Math.min(Math.max(anchor, 1), max);
	if (y <= a) return (y / a) * HERO_END;
	return a >= max ? 1 : HERO_END + ((y - a) / (max - a)) * (1 - HERO_END);
}

/**
 * Repère de fin du hero, en pixels de scroll : le haut du premier texte qui suit
 * la maquette (`firstTextTop`, position dans la page) arrive en bas de la
 * fenêtre. Au moins 1 px : sur une fenêtre haute où ce texte est déjà visible en
 * haut de page, la palette passe au crépuscule dès le premier pixel (en haut de
 * page, le fond sous le hero du calque, --sky-below, garde le contraste). Au plus
 * le hero entier (fenêtre basse) et la moitié de la hauteur défilable.
 */
export function heroAnchor(m: {
	heroHeight: number;
	firstTextTop: number;
	viewport: number;
	max: number;
}): number {
	const anchor = Math.min(m.firstTextTop - m.viewport, m.heroHeight, m.max / 2);
	return Math.max(anchor, 1);
}

/** Mesures du repère dans la page ; sans hero ni texte après lui : `HERO_END` du scroll. */
function measureAnchor(win: Window, max: number): number {
	const doc = win.document;
	const hero = doc.querySelector<HTMLElement>(".landing-hero");
	const text = doc.querySelector<HTMLElement>(".landing-main [data-reveal]");
	if (!hero || !text) return HERO_END * max;
	return heroAnchor({
		heroHeight: hero.offsetHeight,
		firstTextTop: text.getBoundingClientRect().top + win.scrollY,
		viewport: win.innerHeight,
		max,
	});
}

/**
 * Pilote le calque : écouteur `scroll` passif, au plus une écriture par image
 * (`requestAnimationFrame`) des cinq couleurs et du mélange des positions
 * d'arrêts (`--sky-mix`, 0 au hero, 1 dès sa fin). La hauteur de la page et
 * celle du hero (`--hero-h`) sont relues au redimensionnement de la fenêtre ou
 * de la page, pas à chaque image. Renvoie l'arrêt.
 */
export function startSky(win: Window, layer: HTMLElement): () => void {
	let max = 0;
	let anchor = 0;
	let frame = 0;

	const paint = () => {
		frame = 0;
		const p = scrollProgress(win.scrollY, max, anchor);
		const colors = paletteAt(p);
		colors.forEach((color, i) => {
			layer.style.setProperty(`--s${i + 1}`, color);
		});
		layer.style.setProperty(
			"--sky-mix",
			smoothstep(clamp01(p / HERO_END)).toFixed(4),
		);
	};
	const schedule = () => {
		if (!frame) frame = win.requestAnimationFrame(paint);
	};
	const measure = () => {
		max = Math.max(
			0,
			win.document.documentElement.scrollHeight - win.innerHeight,
		);
		anchor = measureAnchor(win, max);
		const hero = win.document.querySelector<HTMLElement>(".landing-hero");
		if (hero) layer.style.setProperty("--hero-h", `${hero.offsetHeight}px`);
		schedule();
	};

	win.addEventListener("scroll", schedule, { passive: true });
	win.addEventListener("resize", measure);
	// La page change de hauteur sans que la fenêtre bouge (polices, offre).
	const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver })
		.ResizeObserver;
	const observer = Observer ? new Observer(measure) : null;
	if (observer && win.document.body) observer.observe(win.document.body);
	measure();

	return () => {
		win.removeEventListener("scroll", schedule);
		win.removeEventListener("resize", measure);
		observer?.disconnect();
		if (frame) win.cancelAnimationFrame(frame);
		frame = 0;
	};
}
