import { resolve } from "node:path";
import { defineConfig } from "vite";
import { landingPlugin } from "./src/landing/plugin.ts";

export default defineConfig({
	base: "/",
	// Landing rendue au build en FR (`/`) et en NL (`/nl/`).
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
