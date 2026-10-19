// Test de bout en bout des scans, contre la stack de dev (voir README, « Analyses IA en dev »).
//
//   pnpm e2e:scan                 route en flux : POST /api/scans/stream (SSE)
//   pnpm e2e:scan -- --no-stream  ancienne route : POST /api/scans (réponse JSON unique)
//
// Même connexion que e2e-login.ts (compte neuf, donc essai neuf de 3 scans à chaque exécution),
// puis deux scans identiques (annonce sans photo) : le premier appelle le LLM
// (`fromCache: false`), le second est servi depuis le cache (`fromCache: true`, même analyse),
// et `remaining.scans` baisse de 1 à chaque scan. En flux, chaque événement (`stage`, `thinking`,
// `search`, `search_done`, `result`, `error`) est affiché à son arrivée, avec le temps écoulé depuis
// l'envoi ; le premier scan doit passer par l'étape `analyzing`, le second par `cache`.
// Affiche `E2E SCAN OK (provider=<p>, model=<m>, score=<n>)` (code 0) ; sinon nomme l'étape en
// échec (connexion, modèle actif, premier scan, second scan, cache ou quota) et sort avec le code 1.
//
// Le modèle actif (type full) est lu avec `uv run radarnaque-llm list` (dans services/api, avec
// le même fichier d'environnement), ou imposé par E2E_PROVIDER et E2E_MODEL.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	call,
	check,
	envPath,
	field,
	loadConfig,
	login,
	run,
	StepError,
} from "./e2e-lib.js";

const EXTERNAL_ID = "e2e-radarnaque-0001";
// Large marge au-dessus des 180 s d'une analyse côté API.
const STREAM_TIMEOUT_MS = 200_000;

function activeModel(): { provider: string; model: string } {
	const step = "modèle actif";
	const { E2E_PROVIDER, E2E_MODEL } = process.env;
	if (E2E_PROVIDER && E2E_MODEL)
		return { provider: E2E_PROVIDER, model: E2E_MODEL };
	const result = spawnSync(
		"uv",
		["run", "--env-file", envPath, "radarnaque-llm", "list"],
		{ cwd: resolve(import.meta.dirname, "../services/api"), encoding: "utf8" },
	);
	if (result.error || result.status !== 0) {
		// Seule la dernière ligne d'erreur : radarnaque-llm n'y met jamais de secret.
		const last = (result.stderr ?? "").trim().split("\n").at(-1);
		throw new StepError(
			`[${step}] radarnaque-llm list a échoué (${result.error?.message ?? `code ${result.status}`}) : ${last ?? ""}\n` +
				"Définir E2E_PROVIDER et E2E_MODEL pour s'en passer.",
		);
	}
	const match = result.stdout.match(/^\s*full -> ([^/\s]+)\/(\S+)\s*$/m);
	if (!match) {
		throw new StepError(`[${step}] aucun modèle actif pour le type full`);
	}
	return { provider: match[1], model: match[2] };
}

/**
 * Annonce fixe (même identifiant externe à chaque exécution). Le cache d'analyses est partagé
 * entre utilisateurs et valable 24 h : avec un contenu identique d'une exécution à l'autre, le
 * premier scan serait servi depuis le cache. La description porte donc l'identifiant de
 * l'exécution, ce qui crée un snapshot neuf (empreinte du contenu différente).
 */
function scanBody(runId: string) {
	return {
		listing: {
			site: "2ememain.be",
			externalId: EXTERNAL_ID,
			url: `https://www.2ememain.be/v/velos/velos-de-course/${EXTERNAL_ID}`,
			title: "Vélo de course carbone, état neuf (test e2e Radarnaque)",
			description:
				`Annonce de test de bout en bout, exécution ${runId}. ` +
				"Vélo presque neuf, envoi uniquement, paiement par virement avant l'envoi.",
			price: { amountCents: 25000, currency: "EUR" },
			priceType: "fixed",
			category: "Vélos de course",
			condition: "Comme neuf",
			location: { city: "Bruxelles", country: "BE" },
			images: [],
			seller: {
				accountAgeMonths: { min: 0, max: 1 },
				reviewCount: 0,
				verified: false,
			},
		},
		rules: {
			version: 1,
			signals: [
				{ id: "new_account", weight: 20, severity: "warning" },
				{ id: "offsite_payment", weight: 35, severity: "danger" },
			],
		},
		trigger: "button",
	};
}

function remainingScans(body: unknown): unknown {
	return field(field(body, "remaining"), "scans");
}

type SseEvent = { event: string; data: string };

/**
 * Lecteur SSE minimal : découpe le flux sur les lignes vides, lit les lignes `event:` et `data:`
 * et ignore les commentaires (`: ping`) et un événement final non terminé. Le décodeur UTF-8 est en flux : un caractère coupé entre
 * deux morceaux réseau est reconstitué.
 */
async function* readSse(
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
function describe(name: string, data: unknown): string {
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
		case "result":
			return `result (score ${field(data, "score")}, fromCache ${field(data, "fromCache")})`;
		case "error":
			return `error ${field(data, "code")} : ${cut(field(data, "message"), 200)}`;
		default:
			return `${name} ${cut(data)}`;
	}
}

type ScanOutcome = { body: unknown; stages: string[] };

/** Un scan par la route en flux ; chaque événement est affiché dès qu'il arrive. */
async function streamScan(
	step: string,
	url: string,
	request: RequestInit,
): Promise<ScanOutcome> {
	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(url, {
			...request,
			signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
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
	return { body: result, stages };
}

/** Un scan par l'ancienne route, en une seule réponse JSON (`--no-stream`). */
async function plainScan(
	step: string,
	url: string,
	request: RequestInit,
): Promise<ScanOutcome> {
	return { body: (await call(step, url, request)).body, stages: [] };
}

await run(async () => {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	const unknown = args.filter((arg) => arg !== "--no-stream");
	if (unknown.length > 0) {
		throw new StepError(
			`[arguments] option inconnue : ${unknown.join(" ")} (seule --no-stream existe)`,
		);
	}
	const stream = !args.includes("--no-stream");
	const config = loadConfig();
	const { provider, model } = activeModel();
	console.log(`Modèle actif (full) : ${provider}/${model}`);

	let session: Awaited<ReturnType<typeof login>>;
	try {
		session = await login(config, "connexion ");
	} catch (error) {
		throw error instanceof StepError
			? error
			: new StepError(`[connexion] ${(error as Error).message}`);
	}
	const before = field(field(session.me, "totalCap"), "remaining") as number;

	const runId = String(Date.now());
	const request = {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: session.origin,
			authorization: `Bearer ${session.jwt}`,
		},
		body: JSON.stringify(scanBody(runId)),
	};
	const url = `${session.baseUrl}/api/scans${stream ? "/stream" : ""}`;
	const scan = stream ? streamScan : plainScan;
	console.log(
		stream
			? "Route en flux : POST /api/scans/stream"
			: "Route sans flux : POST /api/scans",
	);

	// Premier scan : appel au LLM.
	console.log("Premier scan");
	const { body: first, stages: firstStages } = await scan(
		"premier scan",
		url,
		request,
	);
	const score = field(first, "score");
	check(
		"premier scan",
		typeof score === "number" &&
			Number.isInteger(score) &&
			score >= 0 &&
			score <= 100,
		`score absent ou hors de 0 à 100 : ${JSON.stringify(first)}`,
	);
	if (provider === "stub") {
		check(
			"premier scan",
			score === 42,
			`le faux fournisseur renvoie 42, reçu ${score}`,
		);
	}
	if (stream) {
		check(
			"premier scan",
			firstStages.includes("analyzing"),
			`étape analyzing attendue, étapes reçues : ${JSON.stringify(firstStages)}`,
		);
	}
	check(
		"cache",
		field(first, "fromCache") === false,
		`premier scan : fromCache false attendu, reçu ${JSON.stringify(field(first, "fromCache"))}`,
	);
	check(
		"quota",
		remainingScans(first) === before - 1,
		`premier scan : remaining.scans ${before - 1} attendu, reçu ${JSON.stringify(field(first, "remaining"))}`,
	);
	console.log(
		`✓ premier scan (score ${score}, fromCache false, ${remainingScans(first)} scans restants)`,
	);

	// Second scan, identique : servi depuis le cache, mais compté.
	console.log("Second scan");
	const { body: second, stages: secondStages } = await scan(
		"second scan",
		url,
		request,
	);
	if (stream) {
		check(
			"cache",
			secondStages.includes("cache") && !secondStages.includes("analyzing"),
			`étape cache seule attendue, étapes reçues : ${JSON.stringify(secondStages)}`,
		);
	}
	check(
		"cache",
		field(second, "fromCache") === true,
		`second scan : fromCache true attendu, reçu ${JSON.stringify(field(second, "fromCache"))}`,
	);
	check(
		"cache",
		field(second, "analysisId") === field(first, "analysisId") &&
			field(second, "score") === score,
		`second scan : même analyse attendue (analysisId ${JSON.stringify(field(first, "analysisId"))}), reçu ${JSON.stringify(second)}`,
	);
	check(
		"quota",
		remainingScans(second) === before - 2,
		`second scan : remaining.scans ${before - 2} attendu, reçu ${JSON.stringify(field(second, "remaining"))}`,
	);
	console.log(
		`✓ second scan (fromCache true, même analyse, ${remainingScans(second)} scans restants)`,
	);

	console.log(
		`E2E SCAN OK (provider=${provider}, model=${model}, score=${score})`,
	);
});
