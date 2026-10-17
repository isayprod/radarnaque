// Test de bout en bout des scans, contre la stack de dev (voir README, « Analyses IA en dev »).
//
//   pnpm e2e:scan
//
// Même connexion que e2e-login.ts (compte neuf, donc essai neuf de 3 scans à chaque exécution),
// puis deux `POST /api/scans` identiques (scan texte, sans photo) : le premier appelle le LLM
// (`fromCache: false`), le second est servi depuis le cache (`fromCache: true`, même analyse),
// et `remaining.total` baisse de 1 à chaque scan. Affiche
// `E2E SCAN OK (provider=<p>, model=<m>, score=<n>)` (code 0) ; sinon nomme l'étape en échec
// (connexion, modèle actif, premier scan, second scan, cache ou quota) et sort avec le code 1.
//
// Le modèle actif (type text) est lu avec `uv run radarnaque-llm list` (dans services/api, avec
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

function activeTextModel(): { provider: string; model: string } {
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
	const match = result.stdout.match(/^\s*text -> ([^/\s]+)\/(\S+)\s*$/m);
	if (!match) {
		throw new StepError(`[${step}] aucun modèle actif pour le type text`);
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
		scanKind: "text",
		trigger: "button",
	};
}

function remainingTotal(body: unknown): unknown {
	return field(field(body, "remaining"), "total");
}

await run(async () => {
	const config = loadConfig();
	const { provider, model } = activeTextModel();
	console.log(`Modèle actif (text) : ${provider}/${model}`);

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
	const url = `${session.baseUrl}/api/scans`;

	// Premier scan : appel au LLM.
	const first = (await call("premier scan", url, request)).body;
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
	check(
		"cache",
		field(first, "fromCache") === false,
		`premier scan : fromCache false attendu, reçu ${JSON.stringify(field(first, "fromCache"))}`,
	);
	check(
		"quota",
		remainingTotal(first) === before - 1,
		`premier scan : remaining.total ${before - 1} attendu, reçu ${JSON.stringify(field(first, "remaining"))}`,
	);
	console.log(
		`✓ premier scan (score ${score}, fromCache false, ${remainingTotal(first)} scans restants)`,
	);

	// Second scan, identique : servi depuis le cache, mais compté.
	const second = (await call("second scan", url, request)).body;
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
		remainingTotal(second) === before - 2,
		`second scan : remaining.total ${before - 2} attendu, reçu ${JSON.stringify(field(second, "remaining"))}`,
	);
	console.log(
		`✓ second scan (fromCache true, même analyse, ${remainingTotal(second)} scans restants)`,
	);

	console.log(
		`E2E SCAN OK (provider=${provider}, model=${model}, score=${score})`,
	);
});
