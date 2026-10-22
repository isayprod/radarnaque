import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Galerie visuelle de la pastille (`pnpm --filter extension gallery`, port 3101) :
 * une page de développement qui rend chaque état de la pilule, du panneau et des
 * icônes de cartes, chacun dans son shadow root, avec des doublures locales des
 * clients IA et d'accès (aucun réseau). Hors de WXT : elle n'est jamais construite
 * avec l'extension.
 */
export default defineConfig({
	root: fileURLToPath(new URL("./dev", import.meta.url)),
	plugins: [react(), tailwindcss()],
	// Lu par `lib/config.ts` (lien vers les formules) ; WXT le fournit d'ordinaire.
	define: {
		"import.meta.env.WXT_PUBLIC_URL": JSON.stringify("http://localhost:8080"),
	},
});
