import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dossier = resolve(__dirname, "../public/icon");
const lire = (taille: number) =>
	readFileSync(resolve(dossier, `${taille}.png`));

describe("icônes de l'extension", () => {
	it.each([16, 32, 48, 96, 128])(
		"%i.png est un PNG carré à la bonne taille",
		(taille) => {
			const png = lire(taille);
			expect(png.readUInt32BE(16)).toBe(taille);
			expect(png.readUInt32BE(20)).toBe(taille);
		},
	);

	it("128.png n'est plus l'icône par défaut de WXT", () => {
		const empreinte = createHash("sha256").update(lire(128)).digest("hex");
		expect(empreinte).not.toBe(
			"cc646465937d38c0946585b774380c122a3ddc7737e29670cb7f24352dd8b5e2",
		);
	});
});
