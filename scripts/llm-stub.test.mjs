// Test de scripts/llm-stub.mjs, lancé par `node --test` (pnpm test:scripts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createStubServer } from "./llm-stub.mjs";

const script = new URL("./llm-stub.mjs", import.meta.url).pathname;

// Contenu et clé qui ne doivent jamais apparaître dans les logs.
const SECRET_CONTENT = "Annonce secrète : iPhone 15, contact 0470 12 34 56";
const SECRET_KEY = "sk-stub-ne-doit-pas-fuiter";

const request = (model, { image = false } = {}) => ({
	model,
	messages: [
		{ role: "system", content: "Tu es un expert anti-arnaque." },
		{
			role: "user",
			content: image
				? [
						{ type: "text", text: SECRET_CONTENT },
						{
							type: "image_url",
							image_url: { url: "data:image/jpeg;base64,AAAA" },
						},
					]
				: SECRET_CONTENT,
		},
	],
	temperature: 0.2,
	max_tokens: 800,
	response_format: { type: "json_schema", json_schema: { name: "x" } },
});

const post = (port, path, body) =>
	fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${SECRET_KEY}`,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

const start = async () => {
	const lines = [];
	const server = createStubServer({ log: (line) => lines.push(line) });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, lines, port: server.address().port };
};

const stop = (server) => new Promise((resolve) => server.close(resolve));

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

// Mêmes contraintes que LLMAnalysis (services/api/src/radarnaque_api/llm/client.py).
const assertAnalysis = (analysis) => {
	assert.ok(Number.isInteger(analysis.score), "score entier");
	assert.ok(analysis.score >= 0 && analysis.score <= 100, "score de 0 à 100");
	for (const part of ["summary", "advice"]) {
		assert.ok(nonEmpty(analysis[part]?.fr), `${part}.fr non vide`);
		assert.ok(nonEmpty(analysis[part]?.nl), `${part}.nl non vide`);
	}
	assert.ok(Array.isArray(analysis.reasons) && analysis.reasons.length <= 5);
	for (const reason of analysis.reasons) {
		assert.ok(["info", "warning", "danger"].includes(reason.severity));
		assert.ok(nonEmpty(reason.fr) && nonEmpty(reason.nl));
	}
	assert.deepEqual(
		Object.keys(analysis).sort(),
		["advice", "reasons", "score", "summary"],
		"aucun champ en trop (schéma strict)",
	);
};

test("la réponse est une complétion OpenAI dont le contenu est une LLMAnalysis", async () => {
	const { server, port } = await start();
	try {
		const response = await post(
			port,
			"/v1/chat/completions",
			request("stub-model"),
		);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /application\/json/);
		const body = await response.json();
		assert.equal(body.object, "chat.completion");
		assert.equal(typeof body.id, "string");
		assert.ok(Number.isInteger(body.created));
		assert.equal(body.model, "stub-model");
		assert.equal(body.choices.length, 1);
		const [choice] = body.choices;
		assert.equal(choice.index, 0);
		assert.equal(choice.finish_reason, "stop");
		assert.equal(choice.message.role, "assistant");
		const analysis = JSON.parse(choice.message.content);
		assertAnalysis(analysis);
		assert.equal(analysis.score, 42);
		assert.equal(analysis.reasons.length, 1);
		assert.equal(body.usage.prompt_tokens, 100);
		assert.equal(body.usage.completion_tokens, 50);
		assert.equal(body.usage.total_tokens, 150);
	} finally {
		await stop(server);
	}
});

test("une ligne de log par requête : modèle, messages, images ; jamais le contenu ni la clé", async () => {
	const { server, lines, port } = await start();
	try {
		await (await post(port, "/v1/chat/completions", request("m-texte"))).text();
		await (
			await post(
				port,
				"/v1/chat/completions",
				request("m-image", { image: true }),
			)
		).text();
		assert.equal(lines.length, 2, lines.join("\n"));
		assert.match(lines[0], /m-texte/);
		assert.match(lines[0], /messages=2/);
		assert.match(lines[0], /images=non/);
		assert.match(lines[1], /m-image/);
		assert.match(lines[1], /images=oui/);
		const all = lines.join("\n");
		for (const secret of [
			SECRET_CONTENT,
			"0470",
			SECRET_KEY,
			"Bearer",
			"expert",
		]) {
			assert.ok(!all.includes(secret), `« ${secret} » dans les logs : ${all}`);
		}
	} finally {
		await stop(server);
	}
});

test("un corps qui n'est pas du JSON donne 400, un autre chemin 404", async () => {
	const { server, port } = await start();
	try {
		const bad = await post(port, "/v1/chat/completions", "pas du json");
		assert.equal(bad.status, 400);
		await bad.text();
		const missing = await post(port, "/v1/models", request("x"));
		assert.equal(missing.status, 404);
		await missing.text();
		const get = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`);
		assert.equal(get.status, 404);
		await get.text();
	} finally {
		await stop(server);
	}
});

test("en ligne de commande : écoute sur 127.0.0.1 au port donné et journalise sans contenu", async () => {
	const child = spawn(process.execPath, [script, "0"]);
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	try {
		const port = await new Promise((resolve, reject) => {
			child.stdout.on("data", (d) => {
				stdout += d;
				const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
				if (match) resolve(Number(match[1]));
			});
			child.on("exit", (code) =>
				reject(new Error(`sortie ${code} : ${stdout}${stderr}`)),
			);
		});
		const response = await post(
			port,
			"/v1/chat/completions",
			request("stub-model"),
		);
		assert.equal(response.status, 200);
		assertAnalysis(
			JSON.parse((await response.json()).choices[0].message.content),
		);
		// La ligne de log de la requête est écrite avant la réponse.
		assert.match(stdout, /stub-model/);
		assert.ok(!stdout.includes(SECRET_CONTENT), stdout);
		assert.ok(!stdout.includes(SECRET_KEY), stdout);
	} finally {
		child.kill();
	}
});
