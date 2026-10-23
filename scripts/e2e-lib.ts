// Fonctions communes aux tests de bout en bout (e2e-login.ts, e2e-scan.ts, e2e-identify.ts), contre la stack de
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

export type SseEvent = { event: string; data: string };

/**
 * Lecteur SSE minimal : découpe le flux sur les lignes vides, lit les lignes `event:` et `data:`
 * et ignore les commentaires (`: ping`) et un événement final non terminé. Le décodeur UTF-8 est en flux : un caractère coupé entre
 * deux morceaux réseau est reconstitué.
 */
export async function* readSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	const parse = (block: string): SseEvent | null => {
		let event = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line === "" || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const name = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (name === "event") event = value;
			else if (name === "data") data.push(value);
		}
		return data.length > 0 ? { event, data: data.join("\n") } : null;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			buffer = buffer.replaceAll("\r\n", "\n");
			let cut = buffer.indexOf("\n\n");
			while (cut !== -1) {
				const parsed = parse(buffer.slice(0, cut));
				buffer = buffer.slice(cut + 2);
				if (parsed) yield parsed;
				cut = buffer.indexOf("\n\n");
			}
			if (done) break;
		}
	} finally {
		// Lecture finie, ou abandonnée par l'appelant (sortie anticipée de sa boucle) :
		// le flux est annulé, ce qui ferme la connexion, puis le verrou est rendu.
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Une ligne lisible par événement ; les textes du modèle sont tronqués. */
export function describe(name: string, data: unknown): string {
	const cut = (value: unknown, max = 100) => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > max ? `${text.slice(0, max)}…` : text;
	};
	switch (name) {
		case "stage": {
			const count = field(data, "count");
			return `stage ${field(data, "stage")}${typeof count === "number" ? ` (${count})` : ""}`;
		}
		case "thinking":
			return `thinking partie ${field(data, "part")} : ${cut(field(data, "text"))}`;
		case "search":
			return `search #${field(data, "id")} [${field(data, "aspect")}] ${cut(field(data, "query"), 200)}`;
		case "search_done":
			return `search_done #${field(data, "id")} ok=${field(data, "ok")}, ${field(data, "count")} résultats, domaines ${cut(field(data, "domains"))}`;
		case "page_read":
			return `page_read ${field(data, "domain")} ok=${field(data, "ok")}`;
		case "criteria_cached":
			return `criteria_cached (${field(data, "count")} critères)`;
		case "identification":
			return `identification (${field(data, "status")}, confiance ${field(data, "confidence")}, niveau ${field(data, "level")}, fromCache ${field(data, "fromCache")})`;
		case "identification_error":
			return `identification_error ${field(data, "code")}`;
		case "result":
			return typeof field(data, "score") === "number"
				? `result (score ${field(data, "score")}, fromCache ${field(data, "fromCache")})`
				: `result (identification ${field(data, "status")}, confiance ${field(data, "confidence")}, fromCache ${field(data, "fromCache")})`;
		case "error":
			return `error ${field(data, "code")} : ${cut(field(data, "message"), 200)}`;
		default:
			return `${name} ${cut(data)}`;
	}
}

/**
 * POST en flux SSE : chaque événement est affiché dès qu'il arrive (temps écoulé depuis l'envoi).
 * Rend le contenu de l'événement `result`, les étapes (`stage`) et les noms des événements reçus ;
 * un événement `error`, un refus HTTP ou un flux sans `result` font échouer l'étape.
 */
export async function streamPost(
	step: string,
	url: string,
	request: RequestInit,
	timeoutMs: number,
): Promise<{ result: unknown; stages: string[]; events: string[] }> {
	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(url, {
			...request,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const cause = (error as Error & { cause?: Error }).cause;
		throw new StepError(
			`[${step}] POST ${url} : requête impossible (${cause?.message ?? (error as Error).message})`,
		);
	}
	// Un refus (401, 402, 403, 422, 429) arrive en JSON, avant le flux.
	if (!response.ok || !response.body) {
		throw new StepError(
			`[${step}] POST ${url} : HTTP ${response.status}\n${await response.text()}`,
		);
	}
	const contentType = response.headers.get("content-type") ?? "";
	check(
		step,
		contentType.startsWith("text/event-stream"),
		`content-type text/event-stream attendu, reçu ${JSON.stringify(contentType)}`,
	);
	const stages: string[] = [];
	const events: string[] = [];
	let result: unknown;
	try {
		for await (const { event, data } of readSse(response.body)) {
			let parsed: unknown = data;
			try {
				parsed = JSON.parse(data);
			} catch {
				throw new StepError(
					`[${step}] événement ${event} : données non JSON (${data.slice(0, 100)})`,
				);
			}
			const elapsed = ((Date.now() - started) / 1000).toFixed(1);
			console.log(`  +${elapsed}s ${describe(event, parsed)}`);
			check(step, result === undefined, `événement ${event} après result`);
			events.push(event);
			if (event === "stage") stages.push(String(field(parsed, "stage")));
			if (event === "error") {
				throw new StepError(
					`[${step}] erreur du flux : ${JSON.stringify(parsed)}`,
				);
			}
			if (event === "result") result = parsed;
		}
	} catch (error) {
		if (error instanceof StepError) throw error;
		throw new StepError(
			`[${step}] lecture du flux interrompue : ${(error as Error).message}`,
		);
	}
	check(step, result !== undefined, "flux terminé sans événement result");
	return { result, stages, events };
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
