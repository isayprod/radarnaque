#!/usr/bin/env node
// Vérifie que les ports de dev sont libres avant de lancer la stack.
//
//   node scripts/check-ports.mjs 3000 8000 3100
//
// Code de sortie 1, avec un message par port occupé, si l'un d'eux l'est.
// Les ports de Postgres et de Caddy (Docker) ne sont pas vérifiés : ils ont leur propre
// réglage (POSTGRES_PORT dans infra/.env).
import { connect, createServer } from "node:net";
import { pathToFileURL } from "node:url";

// Une connexion réussie prouve qu'un processus écoute, même lié à une seule adresse
// (sur macOS, un bind sur toutes les adresses réussit malgré un écouteur sur 127.0.0.1).
const accepteConnexion = (port, host) =>
	new Promise((resolve) => {
		const socket = connect({ port, host });
		socket.setTimeout(1000);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(false));
	});

// Un bind refusé couvre les cas où la connexion n'aboutit pas (adresse non locale).
const bindImpossible = (port) =>
	new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(true));
		server.listen(port, () => server.close(() => resolve(false)));
	});

export async function isPortBusy(port) {
	const reponses = await Promise.all([
		accepteConnexion(port, "127.0.0.1"),
		accepteConnexion(port, "::1"),
		bindImpossible(port),
	]);
	return reponses.some(Boolean);
}

export async function findBusyPorts(ports) {
	const busy = await Promise.all(ports.map(isPortBusy));
	return ports.filter((_, i) => busy[i]);
}

async function main(args) {
	const ports = args.map(Number);
	const invalid = args.filter(
		(_, i) => !Number.isInteger(ports[i]) || ports[i] < 1 || ports[i] > 65535,
	);
	if (args.length === 0 || invalid.length > 0) {
		console.error(
			`Port invalide : ${invalid.join(", ") || "(aucun port donné)"}`,
		);
		console.error("Usage : node scripts/check-ports.mjs <port> [<port>...]");
		return 1;
	}
	const busy = await findBusyPorts(ports);
	for (const port of busy) {
		console.error(`Le port ${port} est déjà utilisé.`);
		console.error(
			`  Trouver le processus : lsof -nP -iTCP:${port} -sTCP:LISTEN`,
		);
	}
	if (busy.length > 0) {
		console.error(
			"Libérez le ou les ports ci-dessus, puis relancez `pnpm dev`.",
		);
		return 1;
	}
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = await main(process.argv.slice(2));
}
