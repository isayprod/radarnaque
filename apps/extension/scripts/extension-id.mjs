#!/usr/bin/env node
// Affiche la valeur `key` du manifeste (clé publique DER en base64) et l'identifiant de
// l'extension qui en découle.
//
//   node apps/extension/scripts/extension-id.mjs <clé.pem>
//
// Accepte une clé privée ou publique au format PEM. L'identifiant est formé des
// 32 premiers caractères hexadécimaux du SHA-256 du DER, convertis de 0–f vers a–p.
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {Buffer} der clé publique SubjectPublicKeyInfo (DER) */
export function extensionIdFromDer(der) {
	return [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
		.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
		.join("");
}

/**
 * @param {string | Buffer} pem clé privée ou publique (PEM)
 * @returns {{ key: string, id: string }}
 */
export function extensionIdFromPem(pem) {
	const der = createPublicKey(pem).export({ type: "spki", format: "der" });
	return { key: der.toString("base64"), id: extensionIdFromDer(der) };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const file = process.argv[2];
	if (!file) {
		console.error("Usage : node scripts/extension-id.mjs <clé.pem>");
		process.exit(1);
	}
	const { key, id } = extensionIdFromPem(readFileSync(file));
	console.log(`WXT_EXTENSION_KEY=${key}`);
	console.log(`EXTENSION_ID=${id}`);
}
