import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

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
		};
	},
	hooks: {
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
