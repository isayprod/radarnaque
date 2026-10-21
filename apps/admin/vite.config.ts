import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Servi par Caddy sous /admin/ : les assets sont référencés depuis /admin/assets/.
export default defineConfig({
	base: "/admin/",
	plugins: [react(), tailwindcss()],
});
