import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	base: "/",
	build: {
		rollupOptions: {
			input: {
				main: resolve(import.meta.dirname, "index.html"),
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
