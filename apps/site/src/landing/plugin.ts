/**
 * Plugin Vite de la landing (spec landing §2) : remplace `<!--landing:head-->` et
 * `<!--landing:body-->` des gabarits `index.html` (FR) et `nl/index.html` (NL) par
 * l'en-tête et le corps rendus au build, avec l'offre de secours (`PLANS`).
 *
 * `VITE_CHROME_STORE_URL` et `VITE_PUBLIC_URL` sont lus dans l'environnement du
 * build (`infra/.env` en dev, `ARG` du Dockerfile de Caddy en production).
 */
import type { Locale } from "@radarnaque/shared";
import type { Plugin } from "vite";
import { PLANS } from "../pages-i18n.ts";
import { renderHead } from "./head.ts";
import { renderLanding } from "./render.ts";

const HEAD = "<!--landing:head-->";
const BODY = "<!--landing:body-->";

export interface LandingPluginOptions {
	/** Lien du Chrome Web Store ; sans valeur : `VITE_CHROME_STORE_URL`. */
	storeUrl?: string | null;
	/** Origine publique ; sans valeur : `VITE_PUBLIC_URL` (repli dans `renderHead`). */
	publicUrl?: string;
}

/** Langue d'un gabarit d'après son chemin : `/nl/index.html` → NL, sinon FR. */
export function localeOfPath(path: string): Locale {
	return /(?:^|\/)nl\/(?:index\.html)?$/.test(path) ? "nl" : "fr";
}

export function landingPlugin(options: LandingPluginOptions = {}): Plugin {
	let env: Record<string, string | undefined> = process.env;
	return {
		name: "radarnaque-landing",
		configResolved(config) {
			env = { ...process.env, ...config.env };
		},
		transformIndexHtml: {
			order: "pre",
			handler(html, ctx) {
				if (!html.includes(HEAD) && !html.includes(BODY)) return html;
				const locale = localeOfPath(ctx.path);
				const storeUrl =
					(options.storeUrl ?? env.VITE_CHROME_STORE_URL ?? "").trim() || null;
				const publicUrl = options.publicUrl ?? env.VITE_PUBLIC_URL ?? "";
				// Fonctions de remplacement : un `$` du rendu n'est pas un motif.
				return html
					.replace(HEAD, () => renderHead(locale, publicUrl))
					.replace(BODY, () =>
						renderLanding(locale, { offer: PLANS, storeUrl }),
					);
			},
		},
	};
}
