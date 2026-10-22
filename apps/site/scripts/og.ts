/**
 * Génère les images Open Graph de la landing (spec du socle §2.5, spec landing §2) :
 * `public/og-fr.png` et `public/og-nl.png`, 1200 × 630. Le dégradé du hero, la
 * tuile du logo, « Radarnaque », le titre et l'accroche de la langue.
 * Usage : `pnpm --filter site og` (les PNG générés sont commités). Importé (tests),
 * le module n'écrit rien : seul `node scripts/og.ts` génère les images.
 *
 * resvg ne lit pas le WOFF2 des polices du site : il prend les polices du système
 * (Georgia pour le serif, Helvetica ou Arial pour le sans).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { iconTileSvg } from "@radarnaque/design/logo";
import type { Locale } from "@radarnaque/shared";
import { Resvg } from "@resvg/resvg-js";
import { LANDING_TEXT } from "../src/landing/i18n.ts";

const WIDTH = 1200;
export const HEIGHT = 630;
const MARGIN = 80;

/**
 * Couleurs de `--grad-1` à `--grad-5` (tokens.css, `--gradient-hero`) : resvg
 * ignore les variables CSS. Comme dans le hero de la landing (landing.css),
 * l'arrêt cobalt descend sous les textes, pour que le blanc garde son contraste ;
 * le bleu ciel, le lilas, la pêche et l'orange font l'horizon du bas. Le cobalt
 * plein va jusqu'à 74 % (466 px) : l'accroche (au plus bas vers 440 px) n'est plus
 * à cheval sur le passage au bleu ciel.
 */
export const HERO_STOPS = [
	["#0649b8", 0],
	["#0649b8", 0.74],
	["#4e8fe8", 0.86],
	["#c7b9ec", 0.93],
	["#ffd4ad", 0.97],
	["#e16c3f", 1],
] as const;

/** Corps de l'accroche (px) ; ses jambages descendent d'environ un quart sous la ligne de base. */
const TAGLINE_SIZE = 25;

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Coupe un texte en lignes d'au plus `max` caractères, mot par mot. */
function wrap(text: string, max: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		const next = line ? `${line} ${word}` : word;
		if (next.length > max && line) {
			lines.push(line);
			line = word;
		} else line = next;
	}
	if (line) lines.push(line);
	return lines;
}

/** Lignes de texte blanc à partir de la ligne de base `y`. */
function textLines(
	lines: string[],
	y: number,
	lineHeight: number,
	attrs: string,
): string {
	return lines
		.map(
			(line, i) =>
				`<text x="${MARGIN}" y="${y + i * lineHeight}" ${attrs}>${escapeXml(line)}</text>`,
		)
		.join("");
}

/** Lignes du titre et de l'accroche, et leurs lignes de base (px). */
export function ogLayout(locale: Locale) {
	const t = LANDING_TEXT[locale];
	const title = wrap(t.heroTitle, 20);
	const tagline = wrap(t.heroTagline, 78);
	const titleY = 240;
	const taglineY = titleY + (title.length - 1) * 80 + 76;
	/** Bas de la dernière ligne de l'accroche, jambages compris. */
	const taglineBottom =
		taglineY + (tagline.length - 1) * 36 + Math.ceil(TAGLINE_SIZE * 0.25);
	return { title, tagline, titleY, taglineY, taglineBottom };
}

export function ogSvg(locale: Locale): string {
	const stops = HERO_STOPS.map(
		([color, at]) => `<stop offset="${at}" stop-color="${color}"/>`,
	).join("");
	const tile = iconTileSvg(64).replace("<svg ", `<svg x="${MARGIN}" y="56" `);
	const { title, tagline, titleY, taglineY } = ogLayout(locale);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
		`<defs><linearGradient id="hero" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs>` +
		`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#hero)"/>` +
		tile +
		`<text x="${MARGIN + 84}" y="102" font-family="${SERIF}" font-size="40" fill="#ffffff">Radarnaque</text>` +
		textLines(
			title,
			titleY,
			80,
			`font-family="${SERIF}" font-size="80" letter-spacing="-1.5" fill="#ffffff"`,
		) +
		textLines(
			tagline,
			taglineY,
			36,
			`font-family="${SANS}" font-size="${TAGLINE_SIZE}" fill="#ffffff"`,
		) +
		`</svg>`
	);
}

const publicDir = resolve(import.meta.dirname, "../public");
if (import.meta.main)
	for (const locale of ["fr", "nl"] as const) {
		const png = new Resvg(ogSvg(locale), {
			fitTo: { mode: "width", value: WIDTH },
			font: { loadSystemFonts: true, defaultFontFamily: "Georgia" },
		})
			.render()
			.asPng();
		writeFileSync(resolve(publicDir, `og-${locale}.png`), png);
		console.log(`og-${locale}.png`);
	}
