import type { Locale } from "@radarnaque/shared";
import { storage } from "wxt/utils/storage";

/** Jeton de session Better Auth (plugin bearer). Le JWT, lui, ne vit qu'en mémoire. */
export const sessionToken = storage.defineItem<string | null>(
	"local:sessionToken",
	{ fallback: null },
);

/** Langue choisie dans la popup ; `null` tant que l'utilisateur n'a rien choisi. */
export const localePref = storage.defineItem<Locale | null>("local:locale", {
	fallback: null,
});

/**
 * Connexion en cours (lien ou code envoyé par email) : survit à la fermeture de la popup,
 * pas à celle du navigateur (`storage.session`). `sentAt` en millisecondes epoch.
 */
export interface PendingSignIn {
	email: string;
	sentAt: number;
}

export const pendingSignIn = storage.defineItem<PendingSignIn | null>(
	"session:pendingSignIn",
	{ fallback: null },
);
