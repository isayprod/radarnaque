#!/usr/bin/env node
// Met la landing seule en ligne sur Cloudflare Pages (envoi direct, sans le backend).
//
//   pnpm deploy:landing              construit puis envoie en production
//   pnpm deploy:landing --dry-run    construit seulement, et affiche le dossier préparé
//
// Le site est construit dans un dossier temporaire (apps/site/dist, servi par le Caddy de
// dev, n'est pas touché), puis on retire ce qui ne peut pas vivre sans le backend ou ne
// doit pas encore sortir : /auth/callback (appelle /auth/…) et /privacy (vérifications
// de docs/superpowers/plans/2026-10-20-phase-4a-suivi.md pas faites). /pricing reste :
// sans /api/offer, la page garde l'offre de secours.
//
// Variables lues (infra/.env ne l'est pas, il vise localhost) :
//   VITE_PUBLIC_URL        origine des balises og:/canonical ; vide → radarnaque.mostconsult.be
//   VITE_CHROME_STORE_URL  lien du Chrome Web Store ; vide → pas de lien d'installation
//   PAGES_PROJECT          projet Cloudflare Pages ; vide → radarnaque
//
// Avant le premier envoi : `pnpm dlx wrangler login`, puis
// `pnpm dlx wrangler pages project create radarnaque --production-branch main`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Dossiers du build retirés avant l'envoi. */
export const EXCLUDED_DIRS = ["privacy", "auth"];

/** Mêmes en-têtes que le Caddyfile de production (Pages sert toujours en HTTPS). */
export const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000
`;

/** Retire les pages exclues du build et ajoute le fichier `_headers` de Pages. */
export function preparePagesDir(dir) {
	for (const name of EXCLUDED_DIRS)
		rmSync(join(dir, name), { recursive: true, force: true });
	writeFileSync(join(dir, "_headers"), HEADERS);
}

// `run` est injectable pour les tests.
export function deployLanding(
	{ dryRun = false, env = process.env } = {},
	run = spawnSync,
) {
	const outDir = mkdtempSync(join(tmpdir(), "radarnaque-landing-"));
	const buildEnv = {
		...env,
		VITE_PUBLIC_URL: env.VITE_PUBLIC_URL ?? "",
		VITE_CHROME_STORE_URL: env.VITE_CHROME_STORE_URL ?? "",
	};
	console.log(
		`Build : VITE_PUBLIC_URL=${buildEnv.VITE_PUBLIC_URL || "(repli)"} VITE_CHROME_STORE_URL=${buildEnv.VITE_CHROME_STORE_URL || "(vide)"}`,
	);
	const build = run(
		"pnpm",
		[
			"--filter",
			"site",
			"exec",
			"vite",
			"build",
			"--outDir",
			outDir,
			"--emptyOutDir",
		],
		{ stdio: "inherit", env: buildEnv },
	);
	if (build.status !== 0) {
		rmSync(outDir, { recursive: true, force: true });
		console.error("Le build du site a échoué : rien n'est envoyé.");
		return 1;
	}
	preparePagesDir(outDir);
	if (dryRun) {
		console.log(`Dossier prêt, non envoyé : ${outDir}`);
		return 0;
	}
	// --branch main : déploiement de production, quelle que soit la branche git courante.
	const deploy = run(
		"pnpm",
		[
			"dlx",
			"wrangler@4",
			"pages",
			"deploy",
			outDir,
			"--project-name",
			env.PAGES_PROJECT || "radarnaque",
			"--branch",
			"main",
			"--commit-dirty=true",
		],
		{ stdio: "inherit", env },
	);
	rmSync(outDir, { recursive: true, force: true });
	return deploy.status === 0 ? 0 : 1;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = deployLanding({
		dryRun: process.argv.includes("--dry-run"),
	});
}
