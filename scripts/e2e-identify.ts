// Test de bout en bout de l'identification du produit, contre la stack de dev (voir README,
// « Analyses IA en dev »).
//
//   pnpm e2e:identify                 route en flux : POST /api/identify/stream (SSE)
//   pnpm e2e:identify -- --no-stream  route JSON : POST /api/identify (réponse unique)
//
// Même connexion que e2e-login.ts (compte neuf, donc essai neuf de 3 scans à chaque exécution),
// puis deux identifications identiques (annonce sans photo) : la première lance le pipeline
// (`fromCache: false`), la seconde est servie depuis le cache (`fromCache: true`, même
// identification). En flux, chaque événement (`stage`, `thinking`, `search`, `search_done`, `page_read`,
// `criteria_cached`, `result`, `error`) est affiché à son arrivée ; la première identification doit
// passer par les étapes `reading_photos` puis `identifying`. Avec le faux fournisseur (`stub`) et
// SearXNG, l'étape `criteria` (deux candidats) apparaît aussi, avec ses recherches.
// Affiche `E2E IDENTIFY OK (status=<s>, confidence=<n>, level=<l>)` (code 0) ; sinon nomme
// l'étape en échec et sort avec le code 1.
import {
	call,
	check,
	field,
	loadConfig,
	login,
	run,
	StepError,
	streamPost,
} from "./e2e-lib.js";

const EXTERNAL_ID = "e2e-radarnaque-identify-0001";
// Marge au-dessus des 120 s d'une identification côté API.
const STREAM_TIMEOUT_MS = 140_000;

/**
 * Annonce fixe. Le cache d'identifications est partagé entre utilisateurs : la description
 * porte l'identifiant de l'exécution, ce qui crée un snapshot neuf (empreinte différente) et
 * donc une première identification qui lance vraiment le pipeline.
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

type Outcome = { body: unknown; stages: string[]; events: string[] };

async function identify(
	step: string,
	url: string,
	request: RequestInit,
	stream: boolean,
): Promise<Outcome> {
	if (stream) {
		const { result, stages, events } = await streamPost(
			step,
			url,
			request,
			STREAM_TIMEOUT_MS,
		);
		return { body: result, stages, events };
	}
	return {
		body: (await call(step, url, request)).body,
		stages: [],
		events: [],
	};
}

function checkResult(step: string, body: unknown): void {
	const confidence = field(body, "confidence");
	check(
		step,
		["identified", "uncertain", "none"].includes(
			field(body, "status") as string,
		),
		`status inattendu : ${JSON.stringify(field(body, "status"))}`,
	);
	check(
		step,
		typeof confidence === "number" && confidence >= 0 && confidence <= 100,
		`confidence absente ou hors de 0 à 100 : ${JSON.stringify(confidence)}`,
	);
	check(
		step,
		["sure", "probable", "uncertain"].includes(field(body, "level") as string),
		`level inattendu : ${JSON.stringify(field(body, "level"))}`,
	);
	check(
		step,
		Array.isArray(field(body, "objects")),
		`objects absent : ${JSON.stringify(body)}`,
	);
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

	let session: Awaited<ReturnType<typeof login>>;
	try {
		session = await login(config, "connexion ");
	} catch (error) {
		throw error instanceof StepError
			? error
			: new StepError(`[connexion] ${(error as Error).message}`);
	}

	const request = {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: session.origin,
			authorization: `Bearer ${session.jwt}`,
		},
		body: JSON.stringify(scanBody(String(Date.now()))),
	};
	const url = `${session.baseUrl}/api/identify${stream ? "/stream" : ""}`;
	console.log(
		stream
			? "Route en flux : POST /api/identify/stream"
			: "Route sans flux : POST /api/identify",
	);

	console.log("Première identification");
	const first = await identify("première identification", url, request, stream);
	checkResult("première identification", first.body);
	check(
		"cache",
		field(first.body, "fromCache") === false,
		`première identification : fromCache false attendu, reçu ${JSON.stringify(field(first.body, "fromCache"))}`,
	);
	if (stream) {
		const order = ["reading_photos", "identifying"].map((s) =>
			first.stages.indexOf(s),
		);
		check(
			"première identification",
			order[0] !== -1 && order[1] > order[0],
			`étapes reading_photos puis identifying attendues, reçues : ${JSON.stringify(first.stages)}`,
		);
		console.log(
			`  étape criteria : ${first.stages.includes("criteria") ? "oui" : "non (un seul candidat, critères en base, ou aucun moteur de recherche)"}`,
		);
	}
	const status = field(first.body, "status");
	const confidence = field(first.body, "confidence");
	const level = field(first.body, "level");
	console.log(
		`✓ première identification (${status}, confiance ${confidence}, niveau ${level}, fromCache false)`,
	);

	console.log("Seconde identification");
	const second = await identify("seconde identification", url, request, stream);
	checkResult("seconde identification", second.body);
	check(
		"cache",
		field(second.body, "fromCache") === true,
		`seconde identification : fromCache true attendu, reçu ${JSON.stringify(field(second.body, "fromCache"))}`,
	);
	check(
		"cache",
		field(second.body, "identificationId") ===
			field(first.body, "identificationId"),
		`seconde identification : même identificationId attendu (${JSON.stringify(field(first.body, "identificationId"))}), reçu ${JSON.stringify(field(second.body, "identificationId"))}`,
	);
	if (stream) {
		check(
			"cache",
			!second.stages.includes("reading_photos"),
			`seconde identification : aucune étape du pipeline attendue, reçues : ${JSON.stringify(second.stages)}`,
		);
	}
	console.log("✓ seconde identification (fromCache true, même identification)");

	console.log(
		`E2E IDENTIFY OK (status=${status}, confidence=${confidence}, level=${level})`,
	);
});
