/**
 * Génère les icônes PNG de l'extension depuis le logo (tuile dégradée, logo blanc).
 * Usage : `pnpm --filter @radarnaque/design icons`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { iconTileSvg } from "../src/logo.ts";

const TAILLES = [16, 32, 48, 96, 128];
const sortie = resolve(
	import.meta.dirname,
	"../../../apps/extension/public/icon",
);

mkdirSync(sortie, { recursive: true });
for (const taille of TAILLES) {
	const png = new Resvg(iconTileSvg(taille), {
		fitTo: { mode: "width", value: taille },
	})
		.render()
		.asPng();
	writeFileSync(resolve(sortie, `${taille}.png`), png);
}
