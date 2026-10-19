const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface Env {
	NODE_ENV: NodeEnv;
	PUBLIC_URL: string;
	BETTER_AUTH_SECRET: string;
	DATABASE_URL: string;
	EXTENSION_ID: string;
	API_INTERNAL_URL: string;
	INTERNAL_API_SECRET: string;
	MAIL_FROM: string;
	/** Obligatoire uniquement quand NODE_ENV=production. */
	RESEND_API_KEY: string | undefined;
	/**
	 * Compte de développement qui reçoit le rôle `superuser` (§5.3 bis), normalisé en
	 * minuscules. Absent si vide, et toujours absent quand NODE_ENV=production (validé
	 * hors production seulement).
	 */
	DEV_SUPERUSER_EMAIL?: string;
}

type Source = Record<string, string | undefined>;

/** Forme minimale d'un email (une seule `@`, un point dans le domaine, aucun espace). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email normalisé (espaces retirés, minuscules) ; `undefined` si vide ou absent. */
export function normalizeEmail(value: string | undefined): string | undefined {
	return value?.trim().toLowerCase() || undefined;
}

export function isEmail(value: string): boolean {
	return EMAIL_PATTERN.test(value);
}

function required(source: Source, name: string): string {
	const value = source[name]?.trim();
	if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
	return value;
}

function invalid(name: string, reason: string): Error {
	return new Error(`Variable d'environnement invalide : ${name} (${reason})`);
}

function httpUrl(source: Source, name: string): URL {
	const value = required(source, name);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw invalid(name, "URL attendue");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw invalid(name, "URL http(s) attendue");
	}
	return parsed;
}

/** Origine nue (schéma + hôte + port), sans chemin ni slash final : sert d'iss/aud JWT et d'origine de confiance. */
function origin(source: Source, name: string): string {
	const value = required(source, name);
	if (httpUrl(source, name).origin !== value) {
		throw invalid(name, "origine attendue, sans chemin ni slash final");
	}
	return value;
}

function baseUrl(source: Source, name: string): string {
	httpUrl(source, name);
	return required(source, name).replace(/\/+$/, "");
}

/** Valeur d'exemple de infra/.env.example (préfixe `change-me`, casse ignorée). */
function isPlaceholder(value: string): boolean {
	return /^change-me/i.test(value);
}

/** Mot de passe (décodé) de l'URL Postgres ; chaîne vide si absent ou illisible. */
function databasePassword(url: string): string {
	try {
		return decodeURIComponent(new URL(url).password);
	} catch {
		return "";
	}
}

/**
 * Secret d'au moins 32 caractères. En production, les valeurs d'exemple de
 * infra/.env.example (préfixe `change-me`) sont refusées : elles sont publiques.
 */
function secretValue(source: Source, name: string, nodeEnv: string): string {
	const value = required(source, name);
	if (value.length < 32) throw invalid(name, "au moins 32 caractères");
	if (nodeEnv === "production" && isPlaceholder(value)) {
		throw invalid(
			name,
			"valeur d'exemple change-me refusée en production ; `openssl rand -hex 32`",
		);
	}
	return value;
}

/** Lit et valide l'environnement du service auth. Lève une Error qui nomme la variable fautive. */
export function loadEnv(source: Source = process.env): Env {
	const nodeEnv = required(source, "NODE_ENV");
	if (!(NODE_ENVS as readonly string[]).includes(nodeEnv)) {
		throw invalid("NODE_ENV", `valeurs possibles : ${NODE_ENVS.join(", ")}`);
	}

	const secret = secretValue(source, "BETTER_AUTH_SECRET", nodeEnv);
	const internalSecret = secretValue(source, "INTERNAL_API_SECRET", nodeEnv);

	const extensionId = required(source, "EXTENSION_ID");
	if (!/^[a-p]{32}$/.test(extensionId)) {
		throw invalid("EXTENSION_ID", "exactement 32 lettres de a à p");
	}

	const databaseUrl = required(source, "DATABASE_URL");
	if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
		throw invalid("DATABASE_URL", "URL postgres:// attendue");
	}
	if (
		nodeEnv === "production" &&
		isPlaceholder(databasePassword(databaseUrl))
	) {
		throw invalid(
			"DATABASE_URL",
			"mot de passe d'exemple change-me (POSTGRES_PASSWORD) refusé en production",
		);
	}

	const resendApiKey = source.RESEND_API_KEY?.trim() || undefined;
	if (nodeEnv === "production" && !resendApiKey) {
		throw new Error(
			"Variable d'environnement manquante : RESEND_API_KEY (obligatoire en production)",
		);
	}

	let devSuperuserEmail = normalizeEmail(source.DEV_SUPERUSER_EMAIL);
	if (nodeEnv === "production") {
		// Ignorée en production, même invalide : elle ne doit jamais empêcher le
		// démarrage. Pas de valeur dans le message, même masquée.
		if (devSuperuserEmail) {
			console.warn(
				"[auth] DEV_SUPERUSER_EMAIL est ignoré en production : aucun rôle superuser attribué",
			);
		}
		devSuperuserEmail = undefined;
	} else if (devSuperuserEmail && !isEmail(devSuperuserEmail)) {
		// La valeur n'est jamais reprise dans le message : le dépôt et les logs sont publics.
		throw invalid("DEV_SUPERUSER_EMAIL", "email attendu");
	}

	return {
		NODE_ENV: nodeEnv as NodeEnv,
		PUBLIC_URL: origin(source, "PUBLIC_URL"),
		BETTER_AUTH_SECRET: secret,
		DATABASE_URL: databaseUrl,
		EXTENSION_ID: extensionId,
		API_INTERNAL_URL: baseUrl(source, "API_INTERNAL_URL"),
		INTERNAL_API_SECRET: internalSecret,
		MAIL_FROM: required(source, "MAIL_FROM"),
		RESEND_API_KEY: resendApiKey,
		DEV_SUPERUSER_EMAIL: devSuperuserEmail,
	};
}
