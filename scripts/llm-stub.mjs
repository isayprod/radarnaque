// Faux fournisseur LLM compatible OpenAI, pour les tests de bout en bout (voir README,
// « Analyses IA en dev »). Aucune dépendance, écoute sur 127.0.0.1 uniquement.
//
//   pnpm llm:stub [port]      (20199 par défaut, celui du fournisseur `stub` de providers.toml)
//
// `POST /v1/chat/completions` renvoie toujours la même sortie fixe, sans jamais appeler d'outil :
// l'analyse (score 42, une raison) par défaut, ou celle de l'étape d'identification demandée
// (`radarnaque_read_photos`, `radarnaque_criteria`, `radarnaque_identify`), reconnue au nom du
// schéma (`response_format.json_schema.name`) ou, en mode `json_object`, au schéma ajouté au
// prompt système. L'identification passe par les critères (deux candidats).
// Avec `stream: true`, la réponse part en SSE : une ligne de réflexion factice (`delta.reasoning`, comme OpenRouter), l'analyse en plusieurs morceaux, la fin du choix,
// l'usage si `stream_options.include_usage`, puis `data: [DONE]`. Une ligne de log par requête :
// modèle, nombre de messages, présence d'images, flux. Jamais le contenu des messages ni les
// en-têtes (Authorization peut porter une clé).
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 20199;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // photos en data: URL comprises

/** Analyse fixe, valide pour `LLMAnalysis` (services/api/src/radarnaque_api/llm/client.py). */
export const STUB_ANALYSIS = Object.freeze({
	score: 42,
	summary: {
		fr: "Analyse factice du faux fournisseur : risque moyen.",
		nl: "Nepanalyse van de nepaanbieder: gemiddeld risico.",
	},
	advice: {
		fr: "Ceci est une réponse de test : ne pas s'y fier.",
		nl: "Dit is een testantwoord: niet op vertrouwen.",
	},
	reasons: [
		{
			severity: "warning",
			fr: "Raison factice renvoyée par le faux fournisseur.",
			nl: "Nepreden teruggestuurd door de nepaanbieder.",
		},
	],
});

/** Lecture des photos : un objet principal à deux candidats, donc des critères à chercher. */
export const STUB_READ_PHOTOS = Object.freeze({
	status: "ok",
	objects: [
		{
			role: "main",
			category: "Vélo de course",
			brand: "Stub",
			candidates: ["Stub Racer 100", "Stub Racer 200"],
			relative_value: "high",
		},
	],
	clues: [
		{ text: "Cadre en carbone, logo Stub sur le tube diagonal", photo: null },
	],
	read_reference: null,
	hint_criteria: ["Couleur du cadre", "Marque des freins"],
	photo_observations: [],
	title_mismatch: null,
});

/** Critères : un à vérifier sur photo (décisif), un à demander au vendeur. */
export const STUB_CRITERIA = Object.freeze({
	criteria: [
		{
			kind: "photo",
			decisive: true,
			fr: "Le logo sur le tube diagonal est de la couleur annoncée",
			nl: "Het logo op de schuine buis heeft de aangegeven kleur",
			expected: [
				{ candidate: "Stub Racer 100", fr: "Logo blanc", nl: "Wit logo" },
				{ candidate: "Stub Racer 200", fr: "Logo noir", nl: "Zwart logo" },
			],
			sources: [1],
		},
		{
			kind: "ask_seller",
			decisive: false,
			fr: "Demander l'année de fabrication",
			nl: "Vraag naar het bouwjaar",
			expected: [
				{ candidate: "Stub Racer 100", fr: "2021", nl: "2021" },
				{ candidate: "Stub Racer 200", fr: "2023", nl: "2023" },
			],
			sources: [1],
		},
	],
});

/** Identification : le premier candidat, le critère 1 vu conforme sur la photo 1. */
export const STUB_IDENTIFY = Object.freeze({
	objects: [
		{
			object: 1,
			checks: [{ criterion: 1, observation: "seen_match", photo: 1 }],
			reference: "Stub Racer 100",
			remaining: ["Stub Racer 200"],
			pages: [],
		},
	],
	seller_question: {
		fr: "Quelle est l'année de fabrication du vélo ?",
		nl: "Wat is het bouwjaar van de fiets?",
	},
	retry_query: null,
});

const STEP_OUTPUTS = Object.freeze({
	radarnaque_read_photos: STUB_READ_PHOTOS,
	radarnaque_criteria: STUB_CRITERIA,
	radarnaque_identify: STUB_IDENTIFY,
});

// Titres Pydantic des schémas, présents dans le prompt système en mode `json_object`.
const SCHEMA_TITLES = Object.freeze({
	ReadPhotosOut: "radarnaque_read_photos",
	CriteriaOut: "radarnaque_criteria",
	IdentifyOut: "radarnaque_identify",
});

/** Nom du schéma demandé : `json_schema.name`, sinon le titre du schéma ajouté au prompt système. */
const schemaName = (payload, messages) => {
	const name = payload.response_format?.json_schema?.name;
	if (typeof name === "string") return name;
	const system = messages.find((m) => m?.role === "system");
	if (typeof system?.content !== "string") return null;
	const marker = system.content.lastIndexOf("Schéma JSON exact de la réponse");
	if (marker === -1) return null;
	const tail = system.content.slice(marker);
	for (const [title, code] of Object.entries(SCHEMA_TITLES)) {
		if (
			tail.includes(`"title": "${title}"`) ||
			tail.includes(`"title":"${title}"`)
		)
			return code;
	}
	return null;
};

/** Sortie fixe de l'étape demandée ; l'analyse pour tout autre nom (ou aucun). */
export const outputFor = (name) => STEP_OUTPUTS[name] ?? STUB_ANALYSIS;

const hasImages = (messages) =>
	messages.some(
		(message) =>
			Array.isArray(message?.content) &&
			message.content.some((part) => part?.type === "image_url"),
	);

// Le modèle vient de la requête : borné et échappé, pour qu'il ne puisse pas forger de ligne.
const printable = (value) =>
	JSON.stringify(typeof value === "string" ? value.slice(0, 100) : null);

const send = (res, status, body) => {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
};

const USAGE = Object.freeze({
	prompt_tokens: 100,
	completion_tokens: 50,
	total_tokens: 150,
});

/** Morceaux `chat.completion.chunk` d'une réponse en flux (OpenAI, OpenRouter). */
const streamChunks = ({ id, created, model, includeUsage, output }) => {
	const content = JSON.stringify(output);
	const third = Math.ceil(content.length / 3);
	const chunk = (delta, finish_reason = null) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason }],
	});
	const chunks = [
		chunk({ role: "assistant", content: "" }),
		chunk({ reasoning: "Réflexion factice du faux fournisseur." }),
		chunk({ content: content.slice(0, third) }),
		chunk({ content: content.slice(third, 2 * third) }),
		chunk({ content: content.slice(2 * third) }),
		chunk({}, "stop"),
	];
	if (includeUsage) {
		chunks.push({
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [],
			usage: USAGE,
		});
	}
	return chunks;
};

const sendStream = (res, chunks) => {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
	});
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.end("data: [DONE]\n\n");
};

const error = (res, status, message) =>
	send(res, status, { error: { message, type: "stub_error" } });

const readBody = (req) =>
	new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("corps trop grand"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});

/** Serveur HTTP du faux fournisseur, non démarré (`server.listen(port, "127.0.0.1")`). */
export function createStubServer({ log = console.log } = {}) {
	return createServer(async (req, res) => {
		const path = (req.url ?? "").split("?")[0];
		if (req.method !== "POST" || path !== "/v1/chat/completions") {
			error(res, 404, "chemin inconnu");
			return;
		}
		let payload;
		try {
			payload = JSON.parse(await readBody(req));
		} catch {
			error(res, 400, "corps JSON invalide");
			return;
		}
		if (typeof payload !== "object" || payload === null) {
			error(res, 400, "objet JSON attendu");
			return;
		}
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const stream = payload.stream === true;
		log(
			`llm-stub : model=${printable(payload.model)} messages=${messages.length} images=${hasImages(messages) ? "oui" : "non"} flux=${stream ? "oui" : "non"}`,
		);
		const output = outputFor(schemaName(payload, messages));
		const id = `chatcmpl-stub-${randomUUID()}`;
		const created = Math.floor(Date.now() / 1000);
		const model = typeof payload.model === "string" ? payload.model : "stub";
		if (stream) {
			const includeUsage = payload.stream_options?.include_usage === true;
			sendStream(
				res,
				streamChunks({ id, created, model, includeUsage, output }),
			);
			return;
		}
		send(res, 200, {
			id,
			object: "chat.completion",
			created,
			model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: JSON.stringify(output),
					},
					finish_reason: "stop",
				},
			],
			usage: USAGE,
		});
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const arg = process.argv[2] ?? String(DEFAULT_PORT);
	const port = Number(arg);
	if (!/^\d+$/.test(arg) || port > 65535) {
		console.error(`llm-stub : port invalide : ${arg}`);
		process.exit(1);
	}
	const server = createStubServer();
	server.on("error", (err) => {
		console.error(
			`llm-stub : écoute impossible sur le port ${port} (${err.code ?? err.message})`,
		);
		process.exit(1);
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(
			`llm-stub : écoute sur http://127.0.0.1:${server.address().port}/v1 (Ctrl+C pour arrêter)`,
		);
	});
	const stop = () => server.close(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
