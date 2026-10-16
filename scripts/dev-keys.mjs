#!/usr/bin/env node
// Clé de développement de l'extension : crée infra/extension-dev.pem si elle n'existe pas
// (équivalent de `openssl genrsa -out infra/extension-dev.pem 2048`), puis affiche
// l'identifiant de l'extension et la clé publique à recopier.
//
//   pnpm dev:keys
//
// Le même identifiant sert au service auth (EXTENSION_ID), au site (VITE_EXTENSION_ID)
// et à l'extension (WXT_EXTENSION_KEY, dont il découle).
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { extensionIdFromPem } from "../apps/extension/scripts/extension-id.mjs";

const root = resolve(import.meta.dirname, "..");
const pemPath = resolve(root, "infra/extension-dev.pem");
const shown = relative(process.cwd(), pemPath) || pemPath;

if (existsSync(pemPath)) {
	console.log(`Clé existante : ${shown}`);
} else {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	writeFileSync(pemPath, privateKey, { mode: 0o600, flag: "wx" });
	console.log(`Clé créée : ${shown} (jamais versionnée)`);
}

const { key, id } = extensionIdFromPem(readFileSync(pemPath));

console.log(`
À mettre dans infra/.env :
EXTENSION_ID=${id}
VITE_EXTENSION_ID=${id}

À mettre dans apps/extension/.env :
WXT_EXTENSION_KEY=${key}`);
