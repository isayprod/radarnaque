import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
	plugins: [WxtVitest()],
	test: {
		environment: "happy-dom",
		env: { WXT_PUBLIC_URL: "http://localhost:8080" },
		include: ["test/**/*.test.{ts,tsx}"],
		restoreMocks: true,
		unstubGlobals: true,
	},
});
