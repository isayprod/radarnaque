/**
 * Génère les icônes depuis le logo (tuile dégradée, logo blanc) :
 * - extension : PNG 16, 32, 48, 96 et 128 px ;
 * - site : `favicon.svg` (la tuile en SVG), `favicon-32.png` et `apple-touch-icon.png` (180 px).
 * Usage : `pnpm --filter @radarnaque/design icons`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { iconTileSvg } from "../src/logo.ts";

const racine = resolve(import.meta.dirname, "../../..");

function png(taille: number, svg = iconTileSvg(taille)): Buffer {
	return new Resvg(svg, {
		fitTo: { mode: "width", value: taille },
	})
		.render()
		.asPng();
}

// Extension.
const extension = resolve(racine, "apps/extension/public/icon");
mkdirSync(extension, { recursive: true });
for (const taille of [16, 32, 48, 96, 128])
	writeFileSync(resolve(extension, `${taille}.png`), png(taille));

// Site. Le SVG prend la tuile de 16 px (logo à 75 %) : un onglet l'affiche à 16 px CSS.
const site = resolve(racine, "apps/site/public");
mkdirSync(site, { recursive: true });
// Le titre donne un nom au SVG ouvert seul (et satisfait la règle d'accessibilité de Biome).
const favicon = iconTileSvg(16).replace(">", "><title>Radarnaque</title>");
writeFileSync(resolve(site, "favicon.svg"), `${favicon}\n`);
writeFileSync(resolve(site, "favicon-32.png"), png(32));
// iOS arrondit lui-même l'icône et remplit la transparence de noir : tuile à angles droits.
writeFileSync(
	resolve(site, "apple-touch-icon.png"),
	png(180, iconTileSvg(180).replace(/ rx="[^"]*"/, "")),
);
