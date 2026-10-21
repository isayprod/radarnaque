import type { components } from "@radarnaque/shared";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { SessionProvider } from "../src/session";

type Schemas = components["schemas"];
type Overview = Schemas["AiOverviewOut"];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function apiError(status: number, code: string, message: string): Response {
	return json({ error: { code, message, details: {} } }, status);
}

type Call = { method: string; url: URL; body: unknown };
type Handler = (call: Call) => Response | Promise<Response>;
type Routes = Record<string, Handler>;

// `fetch` remplacé par un faux : routes "METHODE chemin", appels enregistrés.
function fakeFetch(routes: Routes) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const call: Call = {
				method: init?.method ?? "GET",
				url: new URL(url, "http://localhost"),
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			};
			calls.push(call);
			const handler = routes[`${call.method} ${call.url.pathname}`];
			if (!handler) throw new Error(`appel non prévu : ${call.method} ${url}`);
			return handler(call);
		}),
	);
	return {
		sent: (method: string, path: string) =>
			calls.filter((c) => c.method === method && c.url.pathname === path),
	};
}

const base: Routes = {
	"GET /auth/token": () => json({ token: "jwt-1" }),
	"GET /api/me": () => json({ email: "admin@radarnaque.test", role: "admin" }),
};

function overview(over: Partial<Overview> = {}): Overview {
	return {
		activeModelId: 1,
		activePromptVersionId: 11,
		models: [
			{
				id: 1,
				provider: "openai",
				slug: "gpt-5-mini",
				active: true,
				analyses: 12,
				knownProvider: true,
			},
			{
				id: 2,
				provider: "openai",
				slug: "gpt-5",
				active: false,
				analyses: 0,
				knownProvider: true,
			},
			{
				id: 3,
				provider: "retired",
				slug: "legacy-model",
				active: false,
				analyses: 4,
				knownProvider: false,
			},
		],
		providers: [
			{
				code: "openai",
				api: "responses",
				key: "present",
				structuredOutput: "json_schema",
				reasoningEffort: "low",
				maxImages: 4,
			},
			{
				code: "mistral",
				api: "chat",
				key: "absent",
				structuredOutput: "json_object",
				reasoningEffort: null,
				maxImages: null,
			},
			{
				code: "ollama",
				api: "chat",
				key: "not_required",
				structuredOutput: "json_object",
				reasoningEffort: null,
				maxImages: null,
			},
		],
		prompts: [
			{
				id: 11,
				version: 2,
				active: true,
				analyses: 30,
				createdAt: "2026-10-10T10:00:00Z",
			},
			{
				id: 10,
				version: 1,
				active: false,
				analyses: 5,
				createdAt: "2026-10-01T10:00:00Z",
			},
		],
		settings: { cacheTtlHours: 24, rateLimitPerMinute: 30, maxWebSearches: 3 },
		search: {
			backend: "searxng",
			status: "ok",
			url: "http://searxng:8080",
			cacheEntries: 7,
		},
		actions: [
			{
				id: 1,
				action: "ai.model_activated",
				adminUserId: "a1",
				adminEmail: "boss@radarnaque.test",
				targetUserId: null,
				createdAt: "2026-10-11T09:00:00Z",
				details: { from: "gpt-5", to: "gpt-5-mini" },
			},
		],
		...over,
	};
}

const PROMPT_TEXT = "Tu es un expert en arnaques. ".repeat(10);

function renderAt(path: string) {
	window.history.replaceState(null, "", path);
	return render(
		<SessionProvider>
			<App />
		</SessionProvider>,
	);
}

beforeEach(() => {
	window.history.replaceState(null, "", "/admin/ia");
});

afterEach(() => {
	cleanup();
});

describe("écran IA", () => {
	it("providers show key state without value", async () => {
		fakeFetch({ ...base, "GET /api/admin/ai": () => json(overview()) });
		renderAt("/admin/ia");

		const section = await screen.findByRole("region", {
			name: "Fournisseurs",
		});
		const openai = within(within(section).getByRole("row", { name: /openai/ }));
		expect(openai.getByText("Clé présente")).toBeTruthy();
		expect(openai.getByText("low")).toBeTruthy();
		const mistral = within(
			within(section).getByRole("row", { name: /mistral/ }),
		);
		expect(mistral.getByText("Clé absente")).toBeTruthy();
		// reasoningEffort et maxImages absents : « — »
		expect(mistral.getAllByText("—")).toHaveLength(2);
		const ollama = within(within(section).getByRole("row", { name: /ollama/ }));
		expect(ollama.getByText("Pas de clé requise")).toBeTruthy();
	});

	it("add model then list refreshes", async () => {
		const added = overview().models.concat({
			id: 4,
			provider: "mistral",
			slug: "mistral-large",
			active: false,
			analyses: 0,
			knownProvider: true,
		});
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/models": () => json(overview({ models: added })),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Modèles" });

		await user.selectOptions(
			within(section).getByLabelText("Fournisseur"),
			"mistral",
		);
		await user.type(within(section).getByLabelText("Slug"), "mistral-large");
		await user.click(
			within(section).getByRole("button", { name: "Ajouter le modèle" }),
		);

		expect(await within(section).findByText("mistral-large")).toBeTruthy();
		expect(sent("POST", "/api/admin/ai/models")[0].body).toEqual({
			provider: "mistral",
			slug: "mistral-large",
		});
		expect(
			(within(section).getByLabelText("Slug") as HTMLInputElement).value,
		).toBe("");
	});

	it("add model refuses a slug with a space and shows a conflict", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/models": () =>
				apiError(409, "conflict", "Ce modèle existe déjà."),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Modèles" });
		const add = within(section).getByRole("button", {
			name: "Ajouter le modèle",
		});

		const slug = within(section).getByLabelText("Slug");
		await user.type(slug, "avec espace");
		expect((add as HTMLButtonElement).disabled).toBe(true);

		await user.clear(slug);
		await user.type(slug, "gpt-5");
		await user.click(add);
		expect(await within(section).findByRole("alert")).toHaveProperty(
			"textContent",
			"Ce modèle existe déjà.",
		);
	});

	it("activate model asks confirmation", async () => {
		const after = overview({
			activeModelId: 2,
			models: overview().models.map((m) => ({ ...m, active: m.id === 2 })),
		});
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/active-model": () => json(after),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Modèles" });
		const row = within(within(section).getByRole("row", { name: /gpt-5\s+0/ }));

		await user.click(row.getByRole("button", { name: "Activer" }));
		const dialog = within(await screen.findByRole("dialog"));
		expect(
			dialog.getByText(
				"Les analyses repartiront de zéro pour ce modèle (cache).",
			),
		).toBeTruthy();

		await user.click(dialog.getByRole("button", { name: "Annuler" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(sent("POST", "/api/admin/ai/active-model")).toHaveLength(0);

		await user.click(row.getByRole("button", { name: "Activer" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Activer le modèle",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(sent("POST", "/api/admin/ai/active-model")[0].body).toEqual({
			modelId: 2,
		});
		// le modèle actif n'a plus de bouton « Activer »
		const mini = within(
			within(section).getByRole("row", { name: /gpt-5-mini/ }),
		);
		expect(mini.getByRole("button", { name: "Activer" })).toBeTruthy();
		expect(row.queryByRole("button", { name: "Activer" })).toBeNull();
	});

	it("a model of an unknown provider cannot be activated", async () => {
		fakeFetch({ ...base, "GET /api/admin/ai": () => json(overview()) });
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Modèles" });
		const row = within(
			within(section).getByRole("row", { name: /legacy-model/ }),
		);
		expect(
			(row.getByRole("button", { name: "Activer" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(row.getByText("Fournisseur retiré")).toBeTruthy();
	});

	it("model test shows score or error", async () => {
		let ok = true;
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/models/2/test": () =>
				json(
					ok
						? {
								ok: true,
								score: 87,
								durationMs: 1234,
								tokensIn: 420,
								tokensOut: 55,
								raw: '{"score": 87}',
								error: null,
							}
						: {
								ok: false,
								score: null,
								durationMs: 5,
								tokensIn: 0,
								tokensOut: 0,
								raw: "",
								error: "configuration",
							},
				),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Modèles" });
		const row = within(within(section).getByRole("row", { name: /gpt-5\s+0/ }));

		await user.click(row.getByRole("button", { name: "Tester" }));
		const result = await within(section).findByRole("status");
		expect(within(result).getByText(/Score : 87/)).toBeTruthy();
		expect(within(result).getByText(/1234 ms/)).toBeTruthy();
		expect(
			within(result).getByText("Tokens : 420 en entrée, 55 en sortie"),
		).toBeTruthy();
		// réponse brute repliée
		const details = result.querySelector("details") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(within(details).getByText('{"score": 87}')).toBeTruthy();
		expect(sent("POST", "/api/admin/ai/models/2/test")).toHaveLength(1);

		ok = false;
		await user.click(row.getByRole("button", { name: "Tester" }));
		await waitFor(() =>
			expect(within(section).getByRole("status").textContent).toContain(
				"Clé du fournisseur absente",
			),
		);
		expect(within(section).queryByText(/Score :/)).toBeNull();
	});

	it("model test 429 shows the limit message", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/models/2/test": () =>
				apiError(429, "rate_limited", "Trop d'essais en une heure."),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Modèles" });
		const row = within(within(section).getByRole("row", { name: /gpt-5\s+0/ }));
		await user.click(row.getByRole("button", { name: "Tester" }));
		expect(
			await within(section).findByText(
				"Limite d'essais atteinte, réessayez dans une heure.",
			),
		).toBeTruthy();
	});

	it("new prompt prefilled from active, counter and json reminder", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"GET /api/admin/ai/prompts/11": () =>
				json({
					id: 11,
					version: 2,
					active: true,
					analyses: 30,
					createdAt: "2026-10-10T10:00:00Z",
					systemPrompt: PROMPT_TEXT,
				}),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Prompts" });

		await user.click(
			within(section).getByRole("button", { name: "Nouvelle version" }),
		);
		const editor = (await within(section).findByLabelText(
			"Texte de la nouvelle version",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(editor.value).toBe(PROMPT_TEXT));
		expect(
			within(section).getByText(
				`${PROMPT_TEXT.length} caractères (200 à 20 000)`,
			),
		).toBeTruthy();
		expect(
			within(section).getByText(
				"La réponse doit rester au format JSON attendu : le schéma est ajouté par le serveur en mode json_object.",
			),
		).toBeTruthy();
		expect(sent("GET", "/api/admin/ai/prompts/11")).toHaveLength(1);
	});

	it("new prompt is created then listed", async () => {
		let created = false;
		const next = overview({
			prompts: [
				{
					id: 12,
					version: 3,
					active: false,
					analyses: 0,
					createdAt: "2026-10-20T10:00:00Z",
				},
				...overview().prompts,
			],
		});
		const edited = `${PROMPT_TEXT} Et une consigne de plus.`;
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(created ? next : overview()),
			"GET /api/admin/ai/prompts/11": () =>
				json({
					id: 11,
					version: 2,
					active: true,
					analyses: 30,
					createdAt: "2026-10-10T10:00:00Z",
					systemPrompt: PROMPT_TEXT,
				}),
			"POST /api/admin/ai/prompts": () => {
				created = true;
				return json(
					{
						id: 12,
						version: 3,
						active: false,
						analyses: 0,
						createdAt: "2026-10-20T10:00:00Z",
						systemPrompt: edited,
					},
					201,
				);
			},
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Prompts" });
		await user.click(
			within(section).getByRole("button", { name: "Nouvelle version" }),
		);
		const editor = (await within(section).findByLabelText(
			"Texte de la nouvelle version",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(editor.value).toBe(PROMPT_TEXT));
		fireEvent.change(editor, { target: { value: edited } });
		await user.click(
			within(section).getByRole("button", { name: "Créer la version" }),
		);

		expect(await within(section).findByText("Version 3 créée.")).toBeTruthy();
		expect(sent("POST", "/api/admin/ai/prompts")[0].body).toEqual({
			systemPrompt: edited,
		});
		expect(within(section).getByRole("row", { name: /3\s+20/ })).toBeTruthy();
		expect(
			within(section).queryByLabelText("Texte de la nouvelle version"),
		).toBeNull();
	});

	it("prompt under 200 chars cannot be sent", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"GET /api/admin/ai/prompts/11": () =>
				json({
					id: 11,
					version: 2,
					active: true,
					analyses: 30,
					createdAt: "2026-10-10T10:00:00Z",
					systemPrompt: PROMPT_TEXT,
				}),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Prompts" });
		await user.click(
			within(section).getByRole("button", { name: "Nouvelle version" }),
		);
		const editor = (await within(section).findByLabelText(
			"Texte de la nouvelle version",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(editor.value).toBe(PROMPT_TEXT));

		fireEvent.change(editor, { target: { value: "trop court" } });
		const create = within(section).getByRole("button", {
			name: "Créer la version",
		}) as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		expect(
			within(section).getByText("10 caractères (200 à 20 000)"),
		).toBeTruthy();
		await user.click(create);
		expect(sent("POST", "/api/admin/ai/prompts")).toHaveLength(0);
	});

	it("prompt can be read and activated after confirmation", async () => {
		const after = overview({
			activePromptVersionId: 10,
			prompts: overview().prompts.map((p) => ({ ...p, active: p.id === 10 })),
		});
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"GET /api/admin/ai/prompts/10": () =>
				json({
					id: 10,
					version: 1,
					active: false,
					analyses: 5,
					createdAt: "2026-10-01T10:00:00Z",
					systemPrompt: "Premier prompt",
				}),
			"POST /api/admin/ai/prompts/10/activate": () => json(after),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Prompts" });
		const row = within(within(section).getByRole("row", { name: /^1\s/ }));

		await user.click(row.getByRole("button", { name: "Consulter" }));
		const reader = (await within(section).findByLabelText(
			"Texte de la version 1",
		)) as HTMLTextAreaElement;
		expect(reader.value).toBe("Premier prompt");
		expect(reader.readOnly).toBe(true);

		await user.click(row.getByRole("button", { name: "Activer" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Activer la version",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(sent("POST", "/api/admin/ai/prompts/10/activate")).toHaveLength(1);
		await waitFor(() =>
			expect(row.queryByRole("button", { name: "Activer" })).toBeNull(),
		);
	});

	it("ai screen opens the prompt given by the route", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"GET /api/admin/ai/prompts/10": () =>
				json({
					id: 10,
					version: 1,
					active: false,
					analyses: 5,
					createdAt: "2026-10-01T10:00:00Z",
					systemPrompt: "Texte de la première version.",
				}),
		});
		renderAt("/admin/ia/prompts/10");
		expect(
			await screen.findByLabelText("Texte de la version 1"),
		).toHaveProperty("value", "Texte de la première version.");
		expect(sent("GET", "/api/admin/ai/prompts/10")).toHaveLength(1);
	});

	it("settings confirmation lists changes and privacy warning on maxWebSearches", async () => {
		const after = overview({
			settings: {
				cacheTtlHours: 48,
				rateLimitPerMinute: 30,
				maxWebSearches: 2,
			},
		});
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"PATCH /api/admin/ai/settings": () => json(after),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Réglages" });
		const save = within(section).getByRole("button", {
			name: "Enregistrer",
		}) as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		const ttl = within(section).getByLabelText(/Durée du cache/);
		expect((ttl as HTMLInputElement).min).toBe("1");
		expect((ttl as HTMLInputElement).max).toBe("168");
		await user.clear(ttl);
		await user.type(ttl, "48");

		await user.click(save);
		let dialog = within(await screen.findByRole("dialog"));
		expect(dialog.getByText(/Durée du cache : 24 → 48/)).toBeTruthy();
		expect(dialog.queryByText(/\/privacy/)).toBeNull();
		await user.click(dialog.getByRole("button", { name: "Annuler" }));

		const searches = within(section).getByLabelText(/Recherches web/);
		await user.clear(searches);
		await user.type(searches, "2");
		await user.click(save);
		dialog = within(await screen.findByRole("dialog"));
		expect(dialog.getByText(/Recherches web par analyse : 3 → 2/)).toBeTruthy();
		expect(dialog.getByText(/Durée du cache : 24 → 48/)).toBeTruthy();
		expect(
			dialog.getByText(
				/Pensez à mettre à jour la page \/privacy, qui annonce jusqu'à 3 recherches\./,
			),
		).toBeTruthy();

		await user.click(dialog.getByRole("button", { name: "Enregistrer" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(sent("PATCH", "/api/admin/ai/settings")[0].body).toEqual({
			cacheTtlHours: 48,
			maxWebSearches: 2,
		});
		expect((ttl as HTMLInputElement).value).toBe("48");
		expect(save.disabled).toBe(true);
	});

	it("settings out of range cannot be saved", async () => {
		fakeFetch({ ...base, "GET /api/admin/ai": () => json(overview()) });
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Réglages" });
		const ttl = within(section).getByLabelText(/Durée du cache/);
		await user.clear(ttl);
		await user.type(ttl, "200");
		expect(
			(
				within(section).getByRole("button", {
					name: "Enregistrer",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(ttl.getAttribute("aria-invalid")).toBe("true");
	});

	it("search status is shown", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/ai": () =>
				json(
					overview({
						search: {
							backend: "searxng",
							status: "down",
							url: "http://searxng:8080",
							cacheEntries: null,
						},
					}),
				),
		});
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", {
			name: "Recherche web",
		});
		expect(within(section).getByText("Recherche indisponible")).toBeTruthy();
		expect(within(section).getByText("http://searxng:8080")).toBeTruthy();
	});

	it("search test shows results and disabled state", async () => {
		let status: "ok" | "disabled" = "ok";
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/search-test": () =>
				json(
					status === "ok"
						? { status: "ok", count: 2, text: "1. Résultat A\n2. Résultat B" }
						: { status: "disabled", count: 0, text: "" },
				),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", {
			name: "Recherche web",
		});
		expect(within(section).getByText("Recherche disponible")).toBeTruthy();
		expect(within(section).getByText("http://searxng:8080")).toBeTruthy();
		expect(within(section).getByText(/7 entrées/)).toBeTruthy();

		await user.type(
			within(section).getByLabelText("Requête de test"),
			"montre rolex arnaque",
		);
		await user.click(
			within(section).getByRole("button", { name: "Tester une recherche" }),
		);
		const result = await within(section).findByRole("status");
		expect(result.textContent).toContain("2 résultats");
		expect(result.textContent).toContain("Résultat B");
		expect(sent("POST", "/api/admin/ai/search-test")[0].body).toEqual({
			query: "montre rolex arnaque",
		});

		status = "disabled";
		await user.click(
			within(section).getByRole("button", { name: "Tester une recherche" }),
		);
		await waitFor(() =>
			expect(within(section).getByRole("status").textContent).toContain(
				"La recherche web est désactivée.",
			),
		);
	});

	it("search test 429 shows the limit message", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/ai": () => json(overview()),
			"POST /api/admin/ai/search-test": () =>
				apiError(429, "rate_limited", "Trop d'essais."),
		});
		const user = userEvent.setup();
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", {
			name: "Recherche web",
		});
		await user.type(within(section).getByLabelText("Requête de test"), "x");
		await user.click(
			within(section).getByRole("button", { name: "Tester une recherche" }),
		);
		expect(
			await within(section).findByText(
				"Limite d'essais atteinte, réessayez dans une heure.",
			),
		).toBeTruthy();
	});

	it("shows the AI action log", async () => {
		fakeFetch({ ...base, "GET /api/admin/ai": () => json(overview()) });
		renderAt("/admin/ia");
		const section = await screen.findByRole("region", { name: "Journal" });
		expect(within(section).getByText("Modèle activé")).toBeTruthy();
		expect(within(section).getByText("gpt-5 → gpt-5-mini")).toBeTruthy();
	});

	it("shows a message when the overview cannot be loaded", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/ai": () => apiError(500, "internal", "Erreur."),
		});
		renderAt("/admin/ia");
		expect(
			await screen.findByText("Impossible de charger l'écran IA."),
		).toBeTruthy();
	});
});
