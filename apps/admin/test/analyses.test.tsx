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
type Row = Schemas["AnalysisRowOut"];
type Detail = Schemas["AnalysisDetailOut"];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function apiError(status: number, code: string, message: string): Response {
	return json({ error: { code, message, details: {} } }, status);
}

const ME = { email: "admin@radarnaque.test", role: "admin" };

type Call = { method: string; url: URL };
type Handler = (call: Call) => Response | Promise<Response>;
type Routes = Record<string, Handler>;

// `fetch` remplacé par un faux : routes "METHODE chemin" (sans la query), appels enregistrés.
function fakeFetch(routes: Routes) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const call: Call = {
				method: init?.method ?? "GET",
				url: new URL(url, "http://localhost"),
			};
			calls.push(call);
			const handler = routes[`${call.method} ${call.url.pathname}`];
			if (!handler) throw new Error(`appel non prévu : ${call.method} ${url}`);
			return handler(call);
		}),
	);
	return {
		listCalls: () =>
			calls.filter(
				(c) => c.method === "GET" && c.url.pathname === "/api/admin/analyses",
			),
		sent: (method: string, path: string) =>
			calls.filter((c) => c.method === method && c.url.pathname === path),
	};
}

// L'écran Analyses ne lit que les modèles et les versions de prompt ; le reste sert à l'écran IA,
// où le lien vers le prompt mène.
const AI = {
	activeModelId: 1,
	activePromptVersionId: 11,
	providers: [],
	steps: [],
	settings: {
		cacheTtlHours: 24,
		rateLimitPerMinute: 30,
		maxWebSearches: 3,
		identificationCacheTtlHours: 168,
		criteriaTtlDays: 180,
		criteriaMaxSearches: 2,
		criteriaMaxPages: 3,
		identifyRetryThreshold: 60,
		identifyImageSide: 1280,
		scamSendsPhotos: false,
		identifyEscalationModelId: null,
	},
	search: { backend: "searxng", status: "ok", url: null, cacheEntries: 0 },
	actions: [],
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
			id: 3,
			provider: "retired",
			slug: "legacy-model",
			active: false,
			analyses: 4,
			knownProvider: false,
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
};

const base: Routes = {
	"GET /auth/token": () => json({ token: "jwt-1" }),
	"GET /api/me": () => json(ME),
	"GET /api/admin/ai": () => json(AI),
};

function row(over: Partial<Row> = {}): Row {
	return {
		id: 5,
		createdAt: "2026-10-20T10:00:00Z",
		site: "2ememain.be",
		title: "Vélo électrique",
		score: 72,
		level: "high",
		professional: true,
		modelId: 1,
		model: { provider: "openai", slug: "gpt-5-mini" },
		promptVersionId: 11,
		promptVersion: 2,
		imagesAnalyzed: 3,
		webSearches: 2,
		costUsd: 0.0123,
		llmCalls: 2,
		served: 7,
		partial: false,
		...over,
	};
}

function detail(over: Partial<Detail> = {}): Detail {
	return {
		listing: {
			site: "2ememain.be",
			externalId: "m123",
			url: "https://www.2ememain.be/a/m123",
			title: "Vélo électrique",
			description: "Très bon état, jamais servi.",
			priceCents: 125000,
			currency: "EUR",
			images: [
				"https://img.example.test/1.jpg",
				"https://img.example.test/2.jpg",
			],
			capturedAt: "2026-10-19T08:00:00Z",
		},
		result: {
			score: 72,
			level: "high",
			professional: true,
			texts: {
				fr: { summary: "Résumé en français", advice: "Conseil en français" },
				nl: { summary: "Samenvatting in het Nederlands", advice: "Advies NL" },
			},
			reasons: [
				{
					position: 1,
					severity: "danger",
					fr: "Première raison FR",
					nl: "Eerste reden NL",
				},
				{
					position: 2,
					severity: "info",
					fr: "Deuxième raison FR",
					nl: "Tweede reden NL",
				},
				{
					position: 3,
					severity: "warning",
					fr: "Troisième raison FR",
					nl: "Derde reden NL",
				},
			],
		},
		searches: [
			{ position: 1, query: "première requête", aspect: "vendeur" },
			{ position: 2, query: "seconde requête", aspect: "prix" },
		],
		technical: {
			model: { provider: "openai", slug: "gpt-5-mini" },
			promptVersionId: 11,
			promptVersion: 2,
			tokensIn: 1111,
			tokensOut: 222,
			costUsd: 0.0123,
			imagesAnalyzed: 3,
			inputHash: "abc123hash",
			createdAt: "2026-10-20T10:00:00Z",
			calls: [
				{
					createdAt: "2026-10-20T10:00:00Z",
					tokensIn: 1111,
					tokensOut: 222,
					costUsd: 0.0123,
					imagesAnalyzed: 3,
					webSearches: 2,
				},
				{
					createdAt: "2026-10-18T10:00:00Z",
					tokensIn: 3333,
					tokensOut: 444,
					costUsd: 0.0456,
					imagesAnalyzed: 1,
					webSearches: 0,
				},
			],
		},
		usage: {
			served: 7,
			firstServedAt: "2026-10-18T10:05:00Z",
			lastServedAt: "2026-10-20T11:00:00Z",
		},
		...over,
	};
}

function renderAt(path: string) {
	window.history.replaceState(null, "", path);
	return render(
		<SessionProvider>
			<App />
		</SessionProvider>,
	);
}

beforeEach(() => {
	window.history.replaceState(null, "", "/admin/analyses");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("liste des analyses", () => {
	it("shows the columns of a row", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/analyses": () =>
				json({ items: [row()], nextBefore: null }),
		});
		renderAt("/admin/analyses");
		const link = await screen.findByRole("link", { name: "Vélo électrique" });
		expect(link.getAttribute("href")).toBe("/admin/analyses/5");
		const cells = within(link.closest("tr") as HTMLElement)
			.getAllByRole("cell")
			.map((cell) => cell.textContent);
		expect(cells).toContain("2ememain.be");
		expect(cells.some((text) => text?.includes("72"))).toBe(true);
		expect(cells.some((text) => text?.includes("Élevé"))).toBe(true);
		expect(cells).toContain("openai / gpt-5-mini");
		expect(cells).toContain("v2");
		expect(cells).toContain("0,0123 $");
		const headers = screen
			.getAllByRole("columnheader")
			.map((header) => header.textContent);
		expect(headers).toEqual([
			"Date",
			"Site",
			"Titre",
			"Score",
			"Pro",
			"Modèle",
			"Prompt",
			"Photos",
			"Recherches",
			"Coût",
			"Appels",
			"Servie",
		]);
	});

	it("filters build the query", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/analyses": () =>
				json({ items: [row()], nextBefore: null }),
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses");
		await screen.findByText("Vélo électrique");
		expect(listCalls()).toHaveLength(1);
		expect([...listCalls()[0].url.searchParams.keys()]).toEqual([]);

		await user.selectOptions(screen.getByLabelText("Site"), "2dehands.be");
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		await user.selectOptions(screen.getByLabelText("Niveau"), "high");
		await waitFor(() => expect(listCalls()).toHaveLength(3));

		// Les listes de modèles et de versions viennent de GET /api/admin/ai.
		const modelFilter = screen.getByLabelText("Modèle") as HTMLSelectElement;
		await waitFor(() =>
			expect([...modelFilter.options].map((o) => o.textContent)).toEqual([
				"Tous",
				"openai / gpt-5-mini",
				"retired / legacy-model",
			]),
		);
		await user.selectOptions(modelFilter, "1");
		await waitFor(() => expect(listCalls()).toHaveLength(4));
		const promptFilter = screen.getByLabelText(
			"Version du prompt",
		) as HTMLSelectElement;
		expect([...promptFilter.options].map((o) => o.textContent)).toEqual([
			"Toutes",
			"v2",
			"v1",
		]);
		await user.selectOptions(promptFilter, "10");
		await waitFor(() => expect(listCalls()).toHaveLength(5));

		fireEvent.change(screen.getByLabelText("Du"), {
			target: { value: "2026-10-01" },
		});
		await waitFor(() => expect(listCalls()).toHaveLength(6));
		fireEvent.change(screen.getByLabelText("Au"), {
			target: { value: "2026-10-15" },
		});
		await waitFor(() => expect(listCalls()).toHaveLength(7));
		await user.click(screen.getByLabelText("Avec recherche web"));
		await waitFor(() => expect(listCalls()).toHaveLength(8));
		await user.click(screen.getByLabelText("Partielle"));
		await waitFor(() => expect(listCalls()).toHaveLength(9));

		const params = listCalls()[8].url.searchParams;
		expect(Object.fromEntries(params)).toEqual({
			site: "2dehands.be",
			level: "high",
			modelId: "1",
			promptVersionId: "10",
			from: "2026-10-01",
			to: "2026-10-15",
			withSearch: "true",
			partial: "true",
		});

		// Décocher retire le paramètre : « sans recherche » n'est pas un filtre de l'écran.
		await user.click(screen.getByLabelText("Partielle"));
		await waitFor(() => expect(listCalls()).toHaveLength(10));
		expect(listCalls()[9].url.searchParams.has("partial")).toBe(false);
		expect(listCalls()[9].url.searchParams.get("withSearch")).toBe("true");
	});

	it("search waits for 3 characters and debounces", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/analyses": () =>
				json({ items: [row()], nextBefore: null }),
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses");
		await screen.findByText("Vélo électrique");
		expect(listCalls()).toHaveLength(1);

		const search = screen.getByLabelText("Rechercher dans le titre");
		await user.type(search, "vé");
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(listCalls()).toHaveLength(1);

		// Frappe rapide : une seule requête, avec le texte complet.
		await user.type(search, "lo");
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(listCalls()).toHaveLength(2);
		expect(listCalls()[1].url.searchParams.get("q")).toBe("vélo");

		// Repasser sous 3 caractères retire le filtre.
		await user.clear(search);
		await waitFor(() => expect(listCalls()).toHaveLength(3));
		expect(listCalls()[2].url.searchParams.has("q")).toBe(false);
	});

	it("stale response does not overwrite", async () => {
		let release: (response: Response) => void = () => {};
		const slow = new Promise<Response>((resolve) => {
			release = resolve;
		});
		fakeFetch({
			...base,
			"GET /api/admin/analyses": ({ url }) =>
				url.searchParams.get("level") === "high"
					? json({
							items: [row({ id: 6, title: "Réponse récente" })],
							nextBefore: null,
						})
					: slow,
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses");
		await user.selectOptions(await screen.findByLabelText("Niveau"), "high");
		expect(await screen.findByText("Réponse récente")).toBeTruthy();

		// La première réponse (sans filtre) arrive en retard : elle est ignorée.
		release(
			json({
				items: [row({ id: 4, title: "Réponse ancienne" })],
				nextBefore: "ancien~4",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByText("Réponse récente")).toBeTruthy();
		expect(screen.queryByText("Réponse ancienne")).toBeNull();
		expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();
	});

	it("next page", async () => {
		const cursor = "2026-10-20T10:00:00Z~5";
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/analyses": ({ url }) =>
				url.searchParams.get("before") === cursor
					? json({
							items: [row({ id: 4, title: "Deuxième page" })],
							nextBefore: null,
						})
					: json({ items: [row()], nextBefore: cursor }),
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses");
		await screen.findByText("Vélo électrique");

		await user.click(screen.getByRole("button", { name: "Page suivante" }));
		expect(await screen.findByText("Deuxième page")).toBeTruthy();
		expect(screen.getByText("Vélo électrique")).toBeTruthy();
		// Le jeton est repassé tel quel, sans être modifié ni converti en nombre.
		expect(listCalls()[1].url.searchParams.get("before")).toBe(cursor);
		expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();

		// Un nouveau filtre repart de la première page.
		await user.selectOptions(screen.getByLabelText("Niveau"), "low");
		await waitFor(() => expect(listCalls()).toHaveLength(3));
		expect(listCalls()[2].url.searchParams.has("before")).toBe(false);
	});

	it("a failed reload clears the list and its cursor", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/analyses": ({ url }) =>
				url.searchParams.get("level") === "low"
					? apiError(500, "internal_error", "Erreur.")
					: json({ items: [row()], nextBefore: "curseur~5" }),
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses");
		await screen.findByText("Vélo électrique");
		expect(screen.getByRole("button", { name: "Page suivante" })).toBeTruthy();

		await user.selectOptions(screen.getByLabelText("Niveau"), "low");
		expect(
			await screen.findByText("Impossible de charger la liste."),
		).toBeTruthy();
		expect(screen.queryByText("Vélo électrique")).toBeNull();
		expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();
		expect(listCalls().some((c) => c.url.searchParams.has("before"))).toBe(
			false,
		);
	});

	it("from after to is refused", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/analyses": () =>
				json({ items: [row()], nextBefore: "curseur~5" }),
		});
		renderAt("/admin/analyses");
		await screen.findByText("Vélo électrique");
		expect(listCalls()).toHaveLength(1);

		fireEvent.change(screen.getByLabelText("Au"), {
			target: { value: "2026-10-01" },
		});
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		fireEvent.change(screen.getByLabelText("Du"), {
			target: { value: "2026-10-15" },
		});
		expect(
			await screen.findByText("La date de début doit précéder la date de fin."),
		).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Rien n'est envoyé, et la liste de l'ancien filtre ne reste pas affichée.
		expect(listCalls()).toHaveLength(2);
		expect(screen.queryByText("Vélo électrique")).toBeNull();
		expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();

		// Corrigée, la période est envoyée.
		fireEvent.change(screen.getByLabelText("Du"), {
			target: { value: "2026-09-15" },
		});
		await waitFor(() => expect(listCalls()).toHaveLength(3));
		expect(listCalls()[2].url.searchParams.get("from")).toBe("2026-09-15");
		expect(listCalls()[2].url.searchParams.get("to")).toBe("2026-10-01");
		expect(
			screen.queryByText("La date de début doit précéder la date de fin."),
		).toBeNull();
	});

	it("filters stay usable when the ai lists fail", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/ai": () => apiError(500, "internal_error", "Erreur."),
			"GET /api/admin/analyses": () =>
				json({ items: [row()], nextBefore: null }),
		});
		renderAt("/admin/analyses");
		expect(await screen.findByText("Vélo électrique")).toBeTruthy();
		expect(
			await screen.findByText(
				"Listes des modèles et des versions du prompt indisponibles.",
			),
		).toBeTruthy();
	});

	it("an empty list says so", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/analyses": () => json({ items: [], nextBefore: null }),
		});
		renderAt("/admin/analyses");
		expect(await screen.findByText("Aucune analyse.")).toBeTruthy();
	});
});

describe("détail d'une analyse", () => {
	const routeDetail = (d: Detail): Routes => ({
		...base,
		"GET /api/admin/analyses/5": () => json(d),
	});

	it("opens from the list", async () => {
		fakeFetch({
			...routeDetail(detail()),
			"GET /api/admin/analyses": () =>
				json({ items: [row()], nextBefore: null }),
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses");
		await user.click(
			await screen.findByRole("link", { name: "Vélo électrique" }),
		);
		expect(await screen.findByRole("region", { name: "Annonce" })).toBeTruthy();
		expect(window.location.pathname).toBe("/admin/analyses/5");
		await user.click(screen.getByRole("link", { name: "← Retour à la liste" }));
		expect(window.location.pathname).toBe("/admin/analyses");
	});

	it("detail shows texts, reasons and searches in order", async () => {
		fakeFetch(routeDetail(detail()));
		renderAt("/admin/analyses/5");

		const listing = await screen.findByRole("region", { name: "Annonce" });
		expect(within(listing).getByText("2ememain.be")).toBeTruthy();
		expect(within(listing).getByText("m123")).toBeTruthy();
		expect(
			within(listing).getByText("Très bon état, jamais servi."),
		).toBeTruthy();
		expect(within(listing).getByText("1 250,00 €")).toBeTruthy();
		const link = within(listing).getByRole("link", {
			name: "Voir l'annonce",
		});
		expect(link.getAttribute("href")).toBe("https://www.2ememain.be/a/m123");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(
			within(listing)
				.getAllByRole("link", { name: /img\.example\.test/ })
				.map((a) => a.getAttribute("href")),
		).toEqual([
			"https://img.example.test/1.jpg",
			"https://img.example.test/2.jpg",
		]);

		const result = screen.getByRole("region", { name: "Résultat" });
		expect(within(result).getByText("72")).toBeTruthy();
		expect(within(result).getByText("Élevé")).toBeTruthy();
		expect(within(result).getByText("Résumé en français")).toBeTruthy();
		expect(within(result).getByText("Conseil en français")).toBeTruthy();
		expect(
			within(result).getByText("Samenvatting in het Nederlands"),
		).toBeTruthy();
		expect(within(result).getByText("Advies NL")).toBeTruthy();
		// HTML valide : dans la liste de définitions, un groupe `div` ne contient que dt et dd.
		for (const group of result.querySelectorAll("dl > div")) {
			expect(group.querySelector(":scope > div")).toBeNull();
		}
		const reasons = within(result)
			.getAllByRole("listitem")
			.map((item) => item.textContent ?? "");
		expect(reasons).toHaveLength(3);
		expect(reasons[0]).toContain("Première raison FR");
		expect(reasons[0]).toContain("Eerste reden NL");
		expect(reasons[0]).toContain("Grave");
		expect(reasons[0]).not.toContain("danger");
		expect(reasons[1]).toContain("Deuxième raison FR");
		expect(reasons[1]).toContain("Information");
		expect(reasons[2]).toContain("Attention");
		expect(reasons[2]).not.toContain("warning");
		// Une couleur par gravité (rouge, orange, gris).
		expect(within(result).getByText("Attention").className).toContain(
			"text-orange-700",
		);
		expect(within(result).getByText("Grave").className).toContain(
			"text-red-700",
		);
		expect(within(result).getByText("Information").className).toContain(
			"text-slate-600",
		);

		const searches = within(
			screen.getByRole("region", { name: "Recherches web" }),
		)
			.getAllByRole("listitem")
			.map((item) => item.textContent ?? "");
		expect(searches).toHaveLength(2);
		expect(searches[0]).toContain("première requête");
		expect(searches[0]).toContain("vendeur");
		expect(searches[1]).toContain("seconde requête");
		expect(searches[1]).toContain("prix");

		const technical = screen.getByRole("region", {
			name: "Contexte technique",
		});
		expect(within(technical).getByText("openai / gpt-5-mini")).toBeTruthy();
		expect(within(technical).getByText("abc123hash")).toBeTruthy();
		// Tokens et coût du dernier appel ; puis les appels, du plus récent au plus ancien.
		const calls = within(technical)
			.getAllByRole("row")
			.slice(1)
			.map((tr) => tr.textContent ?? "");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("1111");
		expect(calls[0]).toContain("0,0123 $");
		expect(calls[1]).toContain("3333");
		expect(calls[1]).toContain("0,0456 $");

		const usage = screen.getByRole("region", { name: "Usage" });
		expect(within(usage).getByText("7")).toBeTruthy();
	});

	it("detail without url, price or images", async () => {
		fakeFetch(
			routeDetail(
				detail({
					listing: {
						...detail().listing,
						url: null,
						priceCents: null,
						currency: null,
						images: [],
					},
					searches: [],
					usage: { served: 0, firstServedAt: null, lastServedAt: null },
				}),
			),
		);
		renderAt("/admin/analyses/5");
		const listing = await screen.findByRole("region", { name: "Annonce" });
		expect(within(listing).getByText("Vélo électrique")).toBeTruthy();
		expect(within(listing).queryByRole("link")).toBeNull();
		expect(within(listing).queryByText("Prix")).toBeNull();
		expect(within(listing).queryByText("Photos")).toBeNull();
		expect(
			within(screen.getByRole("region", { name: "Recherches web" })).getByText(
				"Aucune recherche.",
			),
		).toBeTruthy();
		expect(
			within(screen.getByRole("region", { name: "Usage" })).getAllByText("—"),
		).toHaveLength(2);
	});

	it("an unsafe url gets no link", async () => {
		fakeFetch(
			routeDetail(
				detail({
					listing: { ...detail().listing, url: "javascript:alert(1)" },
				}),
			),
		);
		renderAt("/admin/analyses/5");
		const listing = await screen.findByRole("region", { name: "Annonce" });
		expect(
			within(listing).queryByRole("link", { name: "Voir l'annonce" }),
		).toBeNull();
	});

	it("prompt link opens the ai screen on that version", async () => {
		const { sent } = fakeFetch({
			...routeDetail(detail()),
			"GET /api/admin/ai/prompts/11": () =>
				json({
					id: 11,
					version: 2,
					active: true,
					analyses: 30,
					createdAt: "2026-10-10T10:00:00Z",
					systemPrompt: "Texte de la deuxième version.",
				}),
		});
		const user = userEvent.setup();
		renderAt("/admin/analyses/5");
		const technical = await screen.findByRole("region", {
			name: "Contexte technique",
		});
		const link = within(technical).getByRole("link", {
			name: "Version 2 du prompt",
		});
		expect(link.getAttribute("href")).toBe("/admin/ia/prompts/11");
		await user.click(link);
		expect(window.location.pathname).toBe("/admin/ia/prompts/11");
		expect(
			await screen.findByLabelText("Texte de la version 2"),
		).toHaveProperty("value", "Texte de la deuxième version.");
		expect(sent("GET", "/api/admin/ai/prompts/11")).toHaveLength(1);
	});

	it("unknown analysis says so", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/analyses/5": () =>
				apiError(404, "not_found", "Analyse introuvable."),
		});
		renderAt("/admin/analyses/5");
		expect(await screen.findByText("Analyse introuvable.")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "← Retour à la liste" }),
		).toBeTruthy();
	});

	it("a failed load says so", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/analyses/5": () =>
				apiError(500, "internal_error", "Erreur."),
		});
		renderAt("/admin/analyses/5");
		expect(
			await screen.findByText("Impossible de charger l'analyse."),
		).toBeTruthy();
	});
});
