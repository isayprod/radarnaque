// Test de scripts/check-docker.mjs, lancé par `node --test` (pnpm test:scripts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkDocker, DOCKER_DOWN_MESSAGE } from "./check-docker.mjs";

test("Docker disponible : code 0, aucun message", () => {
	const calls = [];
	const messages = [];
	const code = checkDocker(
		(cmd, args) => {
			calls.push([cmd, ...args]);
			return { status: 0 };
		},
		(m) => messages.push(m),
	);
	assert.equal(code, 0);
	assert.deepEqual(calls, [["docker", "info"]]);
	assert.deepEqual(messages, []);
});

test("Docker arrêté : code 1 et message clair", () => {
	const messages = [];
	const code = checkDocker(
		() => ({ status: 1 }),
		(m) => messages.push(m),
	);
	assert.equal(code, 1);
	assert.deepEqual(messages, [DOCKER_DOWN_MESSAGE]);
	assert.equal(
		DOCKER_DOWN_MESSAGE,
		"Docker n'est pas démarré : lancez Docker Desktop ou OrbStack (orbctl start), puis relancez pnpm dev.",
	);
});

test("docker introuvable (erreur de lancement) : code 1 et même message", () => {
	const messages = [];
	const code = checkDocker(
		() => ({ status: null, error: new Error("ENOENT") }),
		(m) => messages.push(m),
	);
	assert.equal(code, 1);
	assert.deepEqual(messages, [DOCKER_DOWN_MESSAGE]);
});

test("en ligne de commande, rend un code cohérent avec `docker info`", () => {
	const docker =
		spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
	const cli = spawnSync(
		process.execPath,
		[new URL("./check-docker.mjs", import.meta.url).pathname],
		{
			encoding: "utf8",
		},
	);
	assert.equal(cli.status, docker ? 0 : 1);
});
