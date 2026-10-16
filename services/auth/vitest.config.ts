import { execFileSync } from "node:child_process";
import { defineConfig } from "vitest/config";

/**
 * testcontainers ne lit pas le contexte Docker courant (OrbStack, Colima…) :
 * à défaut de DOCKER_HOST, on le dérive de `docker context inspect`.
 */
function dockerHost(): string | undefined {
	if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
	try {
		const host = execFileSync(
			"docker",
			["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return host || undefined;
	} catch {
		return undefined;
	}
}

const host = dockerHost();

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 120_000,
		env: host ? { DOCKER_HOST: host } : {},
	},
});
