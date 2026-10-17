// Fonctions communes aux tests de bout en bout (e2e-login.ts, e2e-scan.ts), contre la stack de
// dev (voir README, « Démarrer en dev »).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** Échec d'une étape nommée : le message commence par `[<étape>]`. */
export class StepError extends Error {}

// E2E_ENV_FILE permet de viser une autre stack (ex. la composition de production en local).
export const envPath = process.env.E2E_ENV_FILE
	? resolve(process.env.E2E_ENV_FILE)
	: resolve(import.meta.dirname, "../infra/.env");

export type Config = { baseUrl: string; origin: string };

/** Lit PUBLIC_URL et EXTENSION_ID dans `envPath` ; aucune autre valeur n'en sort. */
export function loadConfig(): Config {
	let env: NodeJS.Dict<string>;
	try {
		env = parseEnv(readFileSync(envPath, "utf8"));
	} catch (error) {
		throw new StepError(
			`[config] lecture de ${envPath} impossible : ${(error as Error).message}`,
		);
	}
	const { PUBLIC_URL, EXTENSION_ID } = env;
	if (!PUBLIC_URL || !EXTENSION_ID) {
		throw new StepError(
			`[config] PUBLIC_URL et EXTENSION_ID sont requis dans ${envPath}`,
		);
	}
	return {
		baseUrl: PUBLIC_URL.replace(/\/+$/, ""),
		origin: `chrome-extension://${EXTENSION_ID}`,
	};
}

/** Exécute une requête ; tout statut hors 2xx (ou erreur réseau) fait échouer l'étape. */
export async function call(
	step: string,
	url: string,
	init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		const cause = (error as Error & { cause?: Error }).cause;
		throw new StepError(
			`[${step}] ${init.method ?? "GET"} ${url} : requête impossible (${cause?.message ?? (error as Error).message})`,
		);
	}
	const text = await response.text();
	if (!response.ok) {
		throw new StepError(
			`[${step}] ${init.method ?? "GET"} ${url} : HTTP ${response.status}\n${text}`,
		);
	}
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Corps non JSON : conservé tel quel.
	}
	return { response, body };
}

export function check(step: string, condition: boolean, detail: string): void {
	if (!condition) throw new StepError(`[${step}] ${detail}`);
}

export function field(body: unknown, name: string): unknown {
	return typeof body === "object" && body !== null
		? (body as Record<string, unknown>)[name]
		: undefined;
}

export type Login = Config & { email: string; jwt: string; me: unknown };

/**
 * Crée un compte neuf (`e2e+<horodatage>@radarnaque.test`, donc un essai neuf de 3 scans à
 * chaque exécution) et enchaîne : /auth/start → /auth/dev/last-email → /auth/sign-in/email-otp
 * → /auth/token → /api/me. `prefix` précède le nom de chaque étape.
 */
export async function login(config: Config, prefix = ""): Promise<Login> {
	const { baseUrl, origin } = config;
	const email = `e2e+${Date.now()}@radarnaque.test`;
	const json = { "content-type": "application/json", origin };
	console.log(`Connexion de ${email} via ${baseUrl} (Origin ${origin})`);

	// 1. Demande de connexion : un email avec lien magique et code.
	let step = `${prefix}1 POST /auth/start`;
	const start = await call(step, `${baseUrl}/auth/start`, {
		method: "POST",
		headers: json,
		body: JSON.stringify({ email, locale: "fr" }),
	});
	check(
		step,
		field(start.body, "ok") === true,
		`réponse inattendue : ${JSON.stringify(start.body)}`,
	);
	console.log(`✓ ${step}`);

	// 2. Code OTP, lu dans le dernier email (route de développement).
	step = `${prefix}2 GET /auth/dev/last-email`;
	const mail = await call(
		step,
		`${baseUrl}/auth/dev/last-email?to=${encodeURIComponent(email)}`,
	);
	const otp = field(mail.body, "otp");
	check(
		step,
		typeof otp === "string" && /^\d{6}$/.test(otp),
		`code OTP absent ou invalide : ${JSON.stringify(mail.body)}`,
	);
	console.log(`✓ ${step}`);

	// 3. Connexion par code : le jeton de session arrive dans `set-auth-token`.
	step = `${prefix}3 POST /auth/sign-in/email-otp`;
	const signIn = await call(step, `${baseUrl}/auth/sign-in/email-otp`, {
		method: "POST",
		headers: json,
		body: JSON.stringify({ email, otp }),
	});
	const sessionToken = signIn.response.headers.get("set-auth-token");
	check(
		step,
		Boolean(sessionToken),
		`en-tête set-auth-token absent (HTTP ${signIn.response.status}) : ${JSON.stringify(signIn.body)}`,
	);
	console.log(`✓ ${step}`);

	// 4. JWT de courte durée, obtenu avec le jeton de session.
	step = `${prefix}4 GET /auth/token`;
	const tokenRes = await call(step, `${baseUrl}/auth/token`, {
		headers: { authorization: `Bearer ${sessionToken}` },
	});
	const jwt = field(tokenRes.body, "token");
	check(
		step,
		typeof jwt === "string" && jwt.split(".").length === 3,
		`JWT absent : ${JSON.stringify(tokenRes.body)}`,
	);
	console.log(`✓ ${step}`);

	// 5. Profil côté API : essai créé avec 3 scans au total.
	step = `${prefix}5 GET /api/me`;
	const me = await call(step, `${baseUrl}/api/me`, {
		headers: { authorization: `Bearer ${jwt}` },
	});
	const plan = field(me.body, "plan");
	const remaining = field(field(me.body, "totalCap"), "remaining");
	check(
		step,
		plan === "trial" && remaining === 3,
		`attendu plan "trial" et totalCap.remaining 3, reçu : ${JSON.stringify(me.body)}`,
	);
	check(
		step,
		field(me.body, "email") === email,
		`email inattendu : ${JSON.stringify(me.body)}`,
	);
	console.log(`✓ ${step} (plan trial, ${remaining} scans restants)`);

	return { ...config, email, jwt: jwt as string, me: me.body };
}

/** Lance `main`, puis sort avec le code 1 et le nom de l'étape en échec, le cas échéant. */
export async function run(main: () => Promise<void>): Promise<void> {
	try {
		await main();
	} catch (error) {
		console.error(
			error instanceof StepError
				? `ÉCHEC ${error.message}`
				: `ÉCHEC inattendu : ${(error as Error).stack ?? error}`,
		);
		process.exit(1);
	}
}
