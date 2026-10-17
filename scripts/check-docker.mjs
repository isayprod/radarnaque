#!/usr/bin/env node
// Vérifie que le démon Docker répond, avant de lancer `docker compose` (pnpm dev).
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DOCKER_DOWN_MESSAGE =
	"Docker n'est pas démarré : lancez Docker Desktop ou OrbStack (orbctl start), puis relancez pnpm dev.";

/** Un démon bloqué ne doit pas figer `pnpm dev` : au-delà, Docker est jugé arrêté. */
export const DOCKER_INFO_TIMEOUT_MS = 10_000;

// `run` et `print` sont injectables pour les tests.
export function checkDocker(run = spawnSync, print = console.error) {
	const result = run("docker", ["info"], {
		stdio: "ignore",
		timeout: DOCKER_INFO_TIMEOUT_MS,
	});
	// Délai dépassé : `error` (ETIMEDOUT) et `status` null, comme un échec.
	if (result.error || result.status !== 0) {
		print(DOCKER_DOWN_MESSAGE);
		return 1;
	}
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = checkDocker();
}
