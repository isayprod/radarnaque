import type { components } from "@radarnaque/shared";
import {
	cleanup,
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
type Dashboard = Schemas["DashboardOut"];
type Stats = Schemas["DashboardStatsOut"];
type Point = Schemas["DailyPointOut"];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

type Call = { method: string; url: URL };
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

function stats(over: Partial<Stats> = {}): Stats {
	return {
		scans: 20,
		llmCalls: 8,
		fromCachePct: 42.4,
		failedPct: 5.6,
		costUsd: 1.2345,
		avgCostUsd: 0.15432,
		webSearches: 12,
		avgWebSearches: 1.5,
		topFailures: [
			{ code: "llm_timeout", count: 3 },
			{ code: "bad_json", count: 1 },
		],
		...over,
	};
}

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
	return {
		today: stats(),
		last7Days: stats({
			scans: 140,
			llmCalls: 60,
			fromCachePct: 57.14,
			failedPct: 2.4,
			costUsd: 9.8765,
			avgCostUsd: 0.1646,
			webSearches: 80,
			avgWebSearches: 1.33,
			topFailures: [],
		}),
		subscribers: { trial: 5, standard: 3, premium: 2, newAccounts7Days: 4 },
		month: { costUsd: 31.5, projectedUsd: 60.126 },
		health: {
			activeModel: { provider: "openai", slug: "gpt-5-mini" },
			search: { backend: "searxng", status: "ok", url: null, cacheEntries: 7 },
			lastPurge: { at: "2026-10-20T03:00:00Z", deletedScans: 42 },
		},
		...over,
	};
}

// Un point par jour, du 22/09 au 21/10 (30 jours).
function daily(
	over: (index: number, date: string) => Partial<Point> = () => ({}),
) {
	const points: Point[] = [];
	for (let i = 0; i < 30; i++) {
		const date = new Date(Date.UTC(2026, 8, 22 + i)).toISOString().slice(0, 10);
		points.push({
			date,
			fromCache: 0,
			llm: 0,
			failed: 0,
			costUsd: 0,
			...over(i, date),
		});
	}
	return { points };
}

function renderAt(path: string) {
	window.history.replaceState(null, "", path);
	return render(
		<SessionProvider>
			<App />
		</SessionProvider>,
	);
}

function pageRoutes(page: Dashboard, days: { points: Point[] }): Routes {
	return {
		...base,
		"GET /api/admin/dashboard": () => json(page),
		"GET /api/admin/dashboard/daily": () => json(days),
	};
}

beforeEach(() => {
	window.history.replaceState(null, "", "/admin/");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function card(name: string) {
	return within(screen.getByRole("region", { name }));
}

describe("écran Tableau de bord", () => {
	it("cards show today and 7 days", async () => {
		const fake = fakeFetch(pageRoutes(dashboard(), daily()));
		renderAt("/admin/");

		await screen.findByRole("region", { name: "Analyses" });
		expect(fake.sent("GET", "/api/admin/dashboard/daily")[0].url.search).toBe(
			"?days=30",
		);

		const analyses = card("Analyses");
		expect(analyses.getByText("Aujourd'hui").nextSibling?.textContent).toBe(
			"20",
		);
		expect(analyses.getByText("7 jours").nextSibling?.textContent).toBe("140");
		expect(card("Appels au modèle").getByText("60")).toBeTruthy();

		// pourcentages arrondis à l'entier
		const cache = card("Servies depuis le cache");
		expect(cache.getByText("42 %")).toBeTruthy();
		expect(cache.getByText("57 %")).toBeTruthy();

		// échecs : part et trois codes
		const failures = card("Échecs");
		expect(failures.getByText("6 %")).toBeTruthy();
		expect(failures.getByText("2 %")).toBeTruthy();
		expect(failures.getByText("llm_timeout : 3, bad_json : 1")).toBeTruthy();

		// coûts : $ à 2 décimales, coût moyen à 4
		const cost = card("Coût IA");
		expect(cost.getByText("1,23 $")).toBeTruthy();
		expect(cost.getByText("9,88 $")).toBeTruthy();
		const average = card("Coût moyen par appel");
		expect(average.getByText("0,1543 $")).toBeTruthy();
		expect(average.getByText("0,1646 $")).toBeTruthy();

		const searches = card("Recherches web");
		expect(searches.getByText("12")).toBeTruthy();
		expect(searches.getByText("80")).toBeTruthy();

		// abonnés, mois, santé
		const subscribers = within(
			screen.getByRole("region", { name: "Abonnés actifs" }),
		);
		expect(subscribers.getByText("Essai").nextSibling?.textContent).toBe("5");
		expect(subscribers.getByText("Standard").nextSibling?.textContent).toBe(
			"3",
		);
		expect(subscribers.getByText("Premium").nextSibling?.textContent).toBe("2");
		expect(
			subscribers.getByText("Nouveaux comptes (7 jours)").nextSibling
				?.textContent,
		).toBe("4");

		const month = within(screen.getByRole("region", { name: "Mois en cours" }));
		expect(month.getByText("31,50 $")).toBeTruthy();
		expect(month.getByText("60,13 $")).toBeTruthy();

		const health = within(
			screen.getByRole("region", { name: "Santé du service" }),
		);
		expect(health.getByText("openai / gpt-5-mini")).toBeTruthy();
		expect(health.getByText("Recherche disponible").className).toContain(
			"text-green-700",
		);
		expect(health.getByText(/42 événements/)).toBeTruthy();
	});

	it("empty values show a dash", async () => {
		const empty = stats({
			scans: 0,
			llmCalls: 0,
			fromCachePct: null,
			failedPct: null,
			costUsd: 0,
			avgCostUsd: null,
			webSearches: 0,
			avgWebSearches: null,
			topFailures: [],
		});
		fakeFetch(
			pageRoutes(
				dashboard({
					today: empty,
					last7Days: empty,
					month: { costUsd: 0, projectedUsd: null },
					health: {
						activeModel: null,
						search: {
							backend: "none",
							status: "disabled",
							url: null,
							cacheEntries: null,
						},
						lastPurge: null,
					},
				}),
				daily(),
			),
		);
		renderAt("/admin/");

		await screen.findByRole("region", { name: "Analyses" });
		expect(card("Analyses").getAllByText("0")).toHaveLength(2);
		for (const name of [
			"Servies depuis le cache",
			"Échecs",
			"Coût moyen par appel",
		]) {
			expect(card(name).getAllByText("—")).toHaveLength(2);
		}
		expect(card("Coût IA").getAllByText("0,00 $")).toHaveLength(2);
		expect(card("Recherches web").getAllByText("0")).toHaveLength(2);

		const month = within(screen.getByRole("region", { name: "Mois en cours" }));
		expect(month.getByText("0,00 $")).toBeTruthy();
		expect(month.getByText("—")).toBeTruthy();

		const health = within(
			screen.getByRole("region", { name: "Santé du service" }),
		);
		expect(health.getByText("Aucun modèle actif")).toBeTruthy();
		expect(health.getByText("Recherche désactivée").className).toContain(
			"text-slate-500",
		);
		expect(health.getByText("Aucune purge")).toBeTruthy();

		// graphique : trente jours à zéro, sans valeur absurde
		expect(
			screen.getAllByText(/^\d\d\/\d\d : 0 cache, 0 appel, 0 échec/),
		).toHaveLength(30);
		// un NaN apparaîtrait dans les attributs du SVG, pas dans le texte
		expect(document.body.innerHTML).not.toMatch(/NaN|Infinity/);
	});

	it("chart has one bar per day with its title", async () => {
		fakeFetch(
			pageRoutes(
				dashboard(),
				daily((i) =>
					i === 29
						? { fromCache: 12, llm: 4, failed: 1, costUsd: 0.42 }
						: i === 28
							? { fromCache: 1, llm: 0, failed: 2, costUsd: 0 }
							: {},
				),
			),
		);
		renderAt("/admin/");

		const chart = await screen.findByRole("img", {
			name: "Analyses par jour, 30 derniers jours",
		});
		expect(chart.querySelectorAll("title")).toHaveLength(30);
		expect(
			within(chart).getByText("22/09 : 0 cache, 0 appel, 0 échec, 0,00 $"),
		).toBeTruthy();
		expect(
			within(chart).getByText("21/10 : 12 cache, 4 appels, 1 échec, 0,42 $"),
		).toBeTruthy();
		expect(
			within(chart).getByText("20/10 : 1 cache, 0 appel, 2 échecs, 0,00 $"),
		).toBeTruthy();

		// une barre empilée par jour (cache, appel, échec) et une ligne de coût
		expect(chart.querySelectorAll("g[data-day]")).toHaveLength(30);
		expect(chart.querySelectorAll("polyline")).toHaveLength(1);

		// légende
		const legend = within(screen.getByRole("list", { name: "Légende" }));
		expect(legend.getByText("Depuis le cache")).toBeTruthy();
		expect(legend.getByText("Avec appel au modèle")).toBeTruthy();
		expect(legend.getByText("En échec")).toBeTruthy();
		expect(legend.getByText("Coût IA du jour")).toBeTruthy();
	});

	it("bar heights are proportional to the counts", async () => {
		fakeFetch(
			pageRoutes(
				dashboard(),
				daily((i) =>
					i === 28
						? { llm: 10, costUsd: 0.2 }
						: i === 29
							? { llm: 5, costUsd: 0.1 }
							: {},
				),
			),
		);
		renderAt("/admin/");

		const chart = await screen.findByRole("img", {
			name: "Analyses par jour, 30 derniers jours",
		});
		expect(chart.outerHTML).not.toMatch(/NaN|Infinity/);
		const barHeight = (date: string) => {
			const rects = chart.querySelectorAll(`g[data-day="${date}"] rect`);
			// 1er rect : zone de survol ; le suivant : la barre `llm`
			return Number(rects[1].getAttribute("height"));
		};
		expect(barHeight("2026-10-20")).toBeGreaterThan(0);
		expect(barHeight("2026-10-20")).toBeCloseTo(2 * barHeight("2026-10-21"), 6);

		// la ligne de coût suit la même échelle : 0,2 $ est deux fois plus haut que 0,1 $
		const ys = chart
			.querySelector("polyline")
			?.getAttribute("points")
			?.split(" ")
			.map((pair) => Number(pair.split(",")[1]));
		expect(ys).toHaveLength(30);
		const bottom = ys?.[0] ?? 0;
		expect(bottom - (ys?.[28] ?? 0)).toBeCloseTo(
			2 * (bottom - (ys?.[29] ?? 0)),
			6,
		);
	});

	it("data table gives the values of each day", async () => {
		fakeFetch(
			pageRoutes(
				dashboard(),
				daily((i) =>
					i === 29 ? { fromCache: 12, llm: 4, failed: 1, costUsd: 0.42 } : {},
				),
			),
		);
		renderAt("/admin/");

		await screen.findByRole("img", {
			name: "Analyses par jour, 30 derniers jours",
		});
		expect(screen.getByText("Voir les données").tagName).toBe("SUMMARY");
		const table = screen.getByRole("table", { hidden: true });
		const rows = within(table).getAllByRole("row", { hidden: true });
		// en-tête + 30 jours
		expect(rows).toHaveLength(31);
		expect(
			within(table)
				.getAllByRole("columnheader", { hidden: true })
				.map((h) => h.textContent),
		).toEqual(["Date", "Depuis le cache", "Avec appel", "En échec", "Coût"]);
		const last = within(rows[30]).getAllByRole("cell", { hidden: true });
		expect(last.map((c) => c.textContent)).toEqual([
			"21/10",
			"12",
			"4",
			"1",
			"0,42 $",
		]);
	});

	it("forbidden dashboard shows access denied", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/dashboard": () =>
				json(
					{ error: { code: "admin_required", message: "", details: {} } },
					403,
				),
			"GET /api/admin/dashboard/daily": () =>
				json(
					{ error: { code: "admin_required", message: "", details: {} } },
					403,
				),
		});
		renderAt("/admin/");

		expect(
			await screen.findByText("Accès réservé aux administrateurs"),
		).toBeTruthy();
		expect(
			screen.queryByText("Impossible de charger le tableau de bord."),
		).toBeNull();
	});

	it("search down is orange and not an error", async () => {
		fakeFetch(
			pageRoutes(
				dashboard({
					health: {
						activeModel: { provider: "openai", slug: "gpt-5-mini" },
						search: {
							backend: "searxng",
							status: "down",
							url: null,
							cacheEntries: null,
						},
						lastPurge: null,
					},
				}),
				daily(),
			),
		);
		renderAt("/admin/");

		const down = await screen.findByText("Recherche indisponible");
		expect(down.className).toContain("text-orange-700");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("button", { name: "Actualiser" })).toBeTruthy();
	});

	it("refresh reloads both endpoints", async () => {
		const releases: (() => void)[] = [];
		let hold = false;
		const gate = () =>
			hold
				? new Promise<void>((resolve) => {
						releases.push(resolve);
					})
				: Promise.resolve();
		const fake = fakeFetch({
			...base,
			"GET /api/admin/dashboard": async () => {
				await gate();
				return json(dashboard());
			},
			"GET /api/admin/dashboard/daily": async () => {
				await gate();
				return json(daily());
			},
		});
		renderAt("/admin/");

		const refresh = await screen.findByRole("button", { name: "Actualiser" });
		await screen.findByRole("region", { name: "Analyses" });
		expect(fake.sent("GET", "/api/admin/dashboard")).toHaveLength(1);
		expect(fake.sent("GET", "/api/admin/dashboard/daily")).toHaveLength(1);
		expect(refresh.hasAttribute("disabled")).toBe(false);

		hold = true;
		await userEvent.click(refresh);
		await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(true));
		expect(fake.sent("GET", "/api/admin/dashboard")).toHaveLength(2);
		expect(fake.sent("GET", "/api/admin/dashboard/daily")).toHaveLength(2);

		hold = false;
		for (const release of releases) release();
		await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
	});

	it("load error shows retry", async () => {
		let failing = true;
		const fake = fakeFetch({
			...base,
			"GET /api/admin/dashboard": () =>
				failing
					? json(
							{ error: { code: "internal", message: "x", details: {} } },
							500,
						)
					: json(dashboard()),
			"GET /api/admin/dashboard/daily": () => json(daily()),
		});
		renderAt("/admin/");

		expect(
			await screen.findByText("Impossible de charger le tableau de bord."),
		).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Analyses" })).toBeNull();

		failing = false;
		await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
		await screen.findByRole("region", { name: "Analyses" });
		expect(
			screen.queryByText("Impossible de charger le tableau de bord."),
		).toBeNull();
		expect(fake.sent("GET", "/api/admin/dashboard")).toHaveLength(2);
	});
});
