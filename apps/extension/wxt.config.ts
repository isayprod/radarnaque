import { fileURLToPath } from "node:url";
import { FONT_FACES } from "@radarnaque/design/fonts";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";
import { CONTENT_MATCHES } from "./lib/content/matches";

const DEV_PUBLIC_URL = "http://localhost:8080";

const ICONS = {
	16: "icon/16.png",
	32: "icon/32.png",
	48: "icon/48.png",
	96: "icon/96.png",
	128: "icon/128.png",
};

/**
 * Origine du site, de /auth et de /api (`WXT_PUBLIC_URL`, lue dans `.env`).
 * `wxt prepare` et Vitest évaluent aussi ce manifeste : la valeur de dev sert alors de
 * repli, et le hook `build:manifestGenerated` refuse de construire sans `.env` complet.
 */
function publicOrigin(): string {
	return new URL(process.env.WXT_PUBLIC_URL || DEV_PUBLIC_URL).origin;
}

export default defineConfig({
	modules: ["@wxt-dev/module-react"],
	// Port fixe, hors de ceux de la stack (3000 auth, 8000 api, 8080 Caddy) : par défaut WXT
	// prend 3000 et masque le service auth sur localhost.
	dev: { server: { port: 3100, strictPort: true } },
	vite: () => ({ plugins: [tailwindcss()] }),
	manifest: () => {
		const origin = publicOrigin();
		// Les motifs de correspondance ignorent le port : en dev, la page de retour est
		// servie par http://localhost:8080.
		const connectable =
			new URL(origin).hostname === "localhost"
				? ["http://localhost/*"]
				: [`${origin}/*`];
		return {
			name: "Radarnaque",
			icons: ICONS,
			action: { default_icon: ICONS },
			key: process.env.WXT_EXTENSION_KEY || undefined,
			permissions: ["storage"],
			host_permissions: [`${origin}/*`],
			externally_connectable: { matches: connectable },
			// Polices lues par le content script (FontFace) depuis les pages prises en charge.
			web_accessible_resources: [
				{ resources: ["fonts/*.woff2"], matches: CONTENT_MATCHES },
			],
		};
	},
	hooks: {
		"build:publicAssets": (_, files) => {
			for (const { file } of FONT_FACES) {
				files.push({
					absoluteSrc: fileURLToPath(
						import.meta.resolve(`@radarnaque/design/fonts/${file}`),
					),
					relativeDest: `fonts/${file}`,
				});
			}
		},
		"build:manifestGenerated": () => {
			for (const name of ["WXT_PUBLIC_URL", "WXT_EXTENSION_KEY"]) {
				if (!process.env[name]) {
					throw new Error(
						`${name} manquant : copiez apps/extension/.env.example vers apps/extension/.env`,
					);
				}
			}
		},
	},
});
