/**
 * En-tête HTML de la landing (spec landing §2) : titre, description, canonical,
 * hreflang, Open Graph, Twitter Card et favicon, par langue. Les adresses sont
 * absolues (aperçus de liens, moteurs) : elles partent de l'origine publique.
 */
import type { Locale } from "@radarnaque/shared";
import { h, toHtml, type VNode } from "../h.ts";
import { LANDING_TEXT } from "./i18n.ts";

/** Origine publique de repli, quand `VITE_PUBLIC_URL` est vide. */
export const DEFAULT_PUBLIC_URL = "https://radarnaque.mostconsult.be";

/** Chemin de la landing de chaque langue. */
export const LANDING_PATH: Record<Locale, string> = { fr: "/", nl: "/nl/" };

const OG_LOCALE: Record<Locale, string> = { fr: "fr_BE", nl: "nl_BE" };

/** Taille des images Open Graph (`scripts/og.ts`). */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/** Lignes de l'en-tête de la landing, à insérer à la place de `<!--landing:head-->`. */
export function renderHead(locale: Locale, publicUrl: string): string {
	const t = LANDING_TEXT[locale];
	const origin = (publicUrl.trim() || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
	const url = (l: Locale) => `${origin}${LANDING_PATH[l]}`;
	const image = `${origin}/og-${locale}.png`;
	const other: Locale = locale === "fr" ? "nl" : "fr";
	const meta = (name: string, content: string) => h("meta", { name, content });
	const property = (name: string, content: string) =>
		h("meta", { property: name, content });
	const nodes: VNode[] = [
		h("title", {}, t.title),
		meta("description", t.description),
		h("link", { rel: "canonical", href: url(locale) }),
		h("link", { rel: "alternate", hreflang: "fr", href: url("fr") }),
		h("link", { rel: "alternate", hreflang: "nl", href: url("nl") }),
		h("link", { rel: "alternate", hreflang: "x-default", href: url("fr") }),
		h("link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }),
		h("link", {
			rel: "icon",
			href: "/favicon-32.png",
			sizes: "32x32",
			type: "image/png",
		}),
		h("link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }),
		property("og:type", "website"),
		property("og:site_name", "Radarnaque"),
		property("og:title", t.title),
		property("og:description", t.description),
		property("og:url", url(locale)),
		property("og:image", image),
		property("og:image:width", String(OG_SIZE.width)),
		property("og:image:height", String(OG_SIZE.height)),
		property("og:image:alt", t.heroTitle),
		property("og:locale", OG_LOCALE[locale]),
		property("og:locale:alternate", OG_LOCALE[other]),
		meta("twitter:card", "summary_large_image"),
		meta("twitter:title", t.title),
		meta("twitter:description", t.description),
		meta("twitter:image", image),
		meta("twitter:image:alt", t.heroTitle),
	];
	return nodes.map(toHtml).join("\n\t\t");
}
