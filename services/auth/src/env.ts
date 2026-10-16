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
}

type Source = Record<string, string | undefined>;

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

/** Lit et valide l'environnement du service auth. Lève une Error qui nomme la variable fautive. */
export function loadEnv(source: Source = process.env): Env {
	const nodeEnv = required(source, "NODE_ENV");
	if (!(NODE_ENVS as readonly string[]).includes(nodeEnv)) {
		throw invalid("NODE_ENV", `valeurs possibles : ${NODE_ENVS.join(", ")}`);
	}

	const secret = required(source, "BETTER_AUTH_SECRET");
	if (secret.length < 32)
		throw invalid("BETTER_AUTH_SECRET", "au moins 32 caractères");

	const extensionId = required(source, "EXTENSION_ID");
	if (!/^[a-p]{32}$/.test(extensionId)) {
		throw invalid("EXTENSION_ID", "exactement 32 lettres de a à p");
	}

	const databaseUrl = required(source, "DATABASE_URL");
	if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
		throw invalid("DATABASE_URL", "URL postgres:// attendue");
	}

	const resendApiKey = source.RESEND_API_KEY?.trim() || undefined;
	if (nodeEnv === "production" && !resendApiKey) {
		throw new Error(
			"Variable d'environnement manquante : RESEND_API_KEY (obligatoire en production)",
		);
	}

	return {
		NODE_ENV: nodeEnv as NodeEnv,
		PUBLIC_URL: origin(source, "PUBLIC_URL"),
		BETTER_AUTH_SECRET: secret,
		DATABASE_URL: databaseUrl,
		EXTENSION_ID: extensionId,
		API_INTERNAL_URL: baseUrl(source, "API_INTERNAL_URL"),
		INTERNAL_API_SECRET: required(source, "INTERNAL_API_SECRET"),
		MAIL_FROM: required(source, "MAIL_FROM"),
		RESEND_API_KEY: resendApiKey,
	};
}
