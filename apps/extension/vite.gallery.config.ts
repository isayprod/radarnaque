import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Galerie visuelle (`pnpm --filter extension gallery`, port 3101) : des pages de
 * développement, hors de WXT, jamais construites avec l'extension.
 * - `gallery.html` : chaque état de la pilule, du panneau et des icônes de cartes,
 *   chacun dans son shadow root, avec des doublures locales des clients IA et
 *   d'accès (aucun réseau) ;
 * - `popup.html` : la popup à 380 px, état choisi par `?state=` (voir
 *   `dev/doubles/scenario.ts`). Les alias remplacent le service worker, le stockage
 *   et l'API du navigateur par les doublures de `dev/doubles/`.
 */
export default defineConfig({
	root: here("./dev"),
	plugins: [react(), tailwindcss()],
	// Sert `/fonts/*.woff2` comme le build de l'extension, où la popup les lit.
	publicDir: here("../../packages/design/src"),
	resolve: {
		alias: [
			// Spécifiers exacts de `entrypoints/popup/App.tsx` : les autres modules
			// gardent les vrais.
			{
				find: /^\.\.\/\.\.\/lib\/messages$/,
				replacement: here("./dev/doubles/messages.ts"),
			},
			{
				find: /^\.\.\/\.\.\/lib\/storage$/,
				replacement: here("./dev/doubles/storage.ts"),
			},
			{ find: /^wxt\/browser$/, replacement: here("./dev/doubles/browser.ts") },
		],
	},
	// Lu par `lib/config.ts` (lien vers les formules) ; WXT le fournit d'ordinaire.
	define: {
		"import.meta.env.WXT_PUBLIC_URL": JSON.stringify("http://localhost:8080"),
	},
});
