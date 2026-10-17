// Test de scripts/check-ports.mjs, lancé par `node --test` (pnpm test:scripts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";

const script = new URL("./check-ports.mjs", import.meta.url).pathname;

const listen = (server) =>
	new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, () => resolve(server.address().port));
	});

const close = (server) => new Promise((resolve) => server.close(resolve));

// Port libre : on en réserve un, puis on le rend.
const freePort = async () => {
	const server = createServer();
	const port = await listen(server);
	await close(server);
	return port;
};

// spawnSync bloquerait la boucle d'événements et donc le serveur de test : on passe par spawn.
const run = (ports) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...ports.map(String)]);
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => resolve({ code, stderr }));
	});

test("un port libre passe", async () => {
	const port = await freePort();
	const { code } = await run([port]);
	assert.equal(code, 0);
});

test("un port occupé fait échouer avec le numéro du port et la commande lsof", async () => {
	const server = createServer();
	const busy = await listen(server);
	try {
		const free = await freePort();
		const { code, stderr } = await run([free, busy]);
		assert.equal(code, 1);
		assert.ok(stderr.includes(String(busy)), stderr);
		assert.ok(stderr.includes(`lsof -nP -iTCP:${busy} -sTCP:LISTEN`), stderr);
		assert.ok(
			!stderr.includes(`TCP:${free} `),
			"le port libre ne doit pas être signalé",
		);
	} finally {
		await close(server);
	}
});

test("un port occupé sur 127.0.0.1 seulement est détecté", async () => {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const busy = server.address().port;
	try {
		const { code, stderr } = await run([busy]);
		assert.equal(code, 1);
		assert.ok(stderr.includes(String(busy)), stderr);
	} finally {
		await close(server);
	}
});

test("un argument qui n'est pas un port est refusé", () => {
	const result = spawnSync(process.execPath, [script, "abc"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("abc"));
});
