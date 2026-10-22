import { resolve } from "node:path";
import { defineConfig } from "vite";
import { landingPlugin } from "./src/landing/plugin.ts";

export default defineConfig({
	base: "/",
	// Landing rendue au build en FR (`/`) et en NL (`/nl/`). Le plugin et les modules
	// qu'il importe (`src/landing/i18n.ts`, `render.ts`, `head.ts`, `mockup.ts`,
	// `src/pages-i18n.ts`…) sont chargés avec cette configuration : `vite build --watch`
	// (`pnpm dev:site`) ne les relit pas. Après une modification, relancer `pnpm dev:site`.
	plugins: [landingPlugin()],
	build: {
		rollupOptions: {
			input: {
				main: resolve(import.meta.dirname, "index.html"),
				nl: resolve(import.meta.dirname, "nl/index.html"),
				"auth/callback": resolve(
					import.meta.dirname,
					"auth/callback/index.html",
				),
				pricing: resolve(import.meta.dirname, "pricing/index.html"),
				privacy: resolve(import.meta.dirname, "privacy/index.html"),
			},
		},
	},
});
