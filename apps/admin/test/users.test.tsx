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
type Row = Schemas["AdminUserRowOut"];
type Card = Schemas["AdminUserOut"];
type Subscription = Schemas["AdminSubscriptionOut"];
type OfferPlan = Schemas["OfferPlanOut"];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function apiError(
	status: number,
	code: string,
	message: string,
	details: Record<string, unknown> = {},
): Response {
	return json({ error: { code, message, details } }, status);
}

function offerPlan(code: string): OfferPlan {
	return {
		code,
		quota: 10,
		quotaPeriod: "month",
		totalScanCap: null,
		maxImages: 4,
		cardIcons: true,
		prices: {},
	};
}

// Les plans viennent de GET /api/admin/offer, pas d'une liste écrite dans l'écran.
function offer(codes: string[] = ["trial", "standard", "premium"]): Response {
	return json({ plans: codes.map(offerPlan), actions: [] });
}

const ME = { email: "admin@radarnaque.test", role: "admin" };

type Call = { method: string; url: URL; body: unknown };
type Handler = (call: Call) => Response | Promise<Response>;

// `fetch` remplacé par un faux : routes "METHODE chemin" (sans la query), appels enregistrés.
function fakeFetch(routes: Record<string, Handler>) {
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
		calls,
		listCalls: () =>
			calls.filter(
				(c) => c.method === "GET" && c.url.pathname === "/api/admin/users",
			),
		sent: (method: string, path: string) =>
			calls.filter((c) => c.method === method && c.url.pathname === path),
	};
}

const base: Routes = {
	"GET /auth/token": () => json({ token: "jwt-1" }),
	"GET /api/me": () => json(ME),
	"GET /api/admin/offer": () => offer(),
};
type Routes = Record<string, Handler>;

function row(over: Partial<Row> = {}): Row {
	return {
		id: "u1",
		email: "alice@radarnaque.test",
		role: "user",
		plan: "trial",
		used: 3,
		remaining: 7,
		createdAt: "2026-10-01T10:00:00Z",
		lastScanAt: null,
		...over,
	};
}

function subscription(over: Partial<Subscription> = {}): Subscription {
	return {
		id: 2,
		plan: "trial",
		status: "active",
		provider: "manual",
		periodStart: "2026-10-01T10:00:00Z",
		periodEnd: null,
		...over,
	};
}

function card(over: Partial<Card> = {}): Card {
	const active = subscription();
	return {
		id: "u1",
		email: "alice@radarnaque.test",
		emailVerified: true,
		createdAt: "2026-10-01T10:00:00Z",
		role: "user",
		subscription: active,
		usage: {
			periodStart: "2026-10-01T10:00:00Z",
			quotas: [{ scanKind: "full", limit: 10, used: 3, remaining: 7 }],
			totalCap: null,
			purgedScans: 2,
		},
		subscriptions: [active],
		scans: [],
		actions: [],
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
	window.history.replaceState(null, "", "/admin/utilisateurs");
});

afterEach(() => {
	cleanup();
});

describe("navigation", () => {
	it("sidebar has five entries and the root is the dashboard", async () => {
		fakeFetch(base);
		renderAt("/admin/");
		const nav = await screen.findByRole("navigation", { name: "Navigation" });
		expect(
			within(nav)
				.getAllByRole("link")
				.map((link) => link.textContent),
		).toEqual(["Tableau de bord", "Utilisateurs", "Offre", "IA", "Analyses"]);
		expect(
			within(nav)
				.getByRole("link", { name: "Tableau de bord" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByRole("heading", { level: 1, name: "Tableau de bord" }),
		).toBeTruthy();
	});

	it("an analysis keeps Analyses active in the sidebar", async () => {
		fakeFetch(base);
		renderAt("/admin/analyses/5");
		const nav = await screen.findByRole("navigation", { name: "Navigation" });
		expect(
			within(nav)
				.getByRole("link", { name: "Analyses" })
				.getAttribute("aria-current"),
		).toBe("page");
	});
});

describe("liste des utilisateurs", () => {
	it("search waits for 3 characters", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/users": () => json({ items: [row()], nextBefore: null }),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs");
		expect(await screen.findByText("alice@radarnaque.test")).toBeTruthy();
		expect(listCalls()).toHaveLength(1);
		expect(listCalls()[0].url.searchParams.has("q")).toBe(false);

		const search = screen.getByLabelText("Rechercher par email");
		await user.type(search, "al");
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(listCalls()).toHaveLength(1);

		await user.type(search, "i");
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		expect(listCalls()[1].url.searchParams.get("q")).toBe("ali");
	});

	it("filters and next page", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/users": ({ url }) => {
				if (url.searchParams.get("before") === "u1") {
					return json({
						items: [
							row({ id: "u2", email: "bob@radarnaque.test", plan: null }),
						],
						nextBefore: null,
					});
				}
				return json({ items: [row()], nextBefore: "u1" });
			},
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs");
		await screen.findByText("alice@radarnaque.test");

		await user.click(screen.getByRole("button", { name: "Page suivante" }));
		expect(await screen.findByText("bob@radarnaque.test")).toBeTruthy();
		expect(screen.getByText("alice@radarnaque.test")).toBeTruthy();
		expect(listCalls()[1].url.searchParams.get("before")).toBe("u1");
		expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();
		expect(screen.getByText("aucun")).toBeTruthy();

		await user.selectOptions(screen.getByLabelText("Rôle"), "admin");
		await waitFor(() => expect(listCalls()).toHaveLength(3));
		expect(listCalls()[2].url.searchParams.get("role")).toBe("admin");
		expect(listCalls()[2].url.searchParams.has("before")).toBe(false);

		await user.selectOptions(screen.getByLabelText("Plan"), "none");
		await waitFor(() => expect(listCalls()).toHaveLength(4));
		expect(listCalls()[3].url.searchParams.get("plan")).toBe("none");
		expect(listCalls()[3].url.searchParams.get("role")).toBe("admin");
	});

	it("a failed reload of a new filter clears the list and its cursor", async () => {
		const { listCalls } = fakeFetch({
			...base,
			"GET /api/admin/users": ({ url }) =>
				url.searchParams.get("role") === "admin"
					? apiError(500, "internal_error", "Erreur.")
					: json({ items: [row()], nextBefore: "u1" }),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs");
		await screen.findByText("alice@radarnaque.test");
		expect(screen.getByRole("button", { name: "Page suivante" })).toBeTruthy();

		await user.selectOptions(screen.getByLabelText("Rôle"), "admin");
		expect(
			await screen.findByText("Impossible de charger la liste."),
		).toBeTruthy();
		expect(screen.queryByText("alice@radarnaque.test")).toBeNull();
		// Sans curseur périmé, aucune page suivante ne peut partir avec le nouveau filtre.
		expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();
		expect(listCalls().some((c) => c.url.searchParams.has("before"))).toBe(
			false,
		);
	});

	it("plan filter comes from the API plans", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/offer": () => offer(["trial", "gold"]),
			"GET /api/admin/users": () => json({ items: [row()], nextBefore: null }),
		});
		renderAt("/admin/utilisateurs");
		await screen.findByText("alice@radarnaque.test");
		const filter = screen.getByLabelText("Plan") as HTMLSelectElement;
		await waitFor(() =>
			expect([...filter.options].map((option) => option.value)).toEqual([
				"",
				"trial",
				"gold",
				"none",
			]),
		);
	});

	it("opens the card of a row", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/users": () => json({ items: [row()], nextBefore: null }),
			"GET /api/admin/users/u1": () => json(card()),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs");
		await user.click(
			await screen.findByRole("link", { name: "alice@radarnaque.test" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Abonnement actif" }),
		).toBeTruthy();
		expect(window.location.pathname).toBe("/admin/utilisateurs/u1");
	});
});

describe("fiche d'un utilisateur", () => {
	const routeCard = (c: Card): Routes => ({
		...base,
		"GET /api/admin/users/u1": () => json(c),
	});

	it("card shows usage, subscriptions, scans and log", async () => {
		const old = subscription({
			id: 1,
			plan: "standard",
			status: "expired",
			periodEnd: "2026-10-01T10:00:00Z",
		});
		fakeFetch(
			routeCard(
				card({
					subscriptions: [subscription(), old],
					scans: [
						{
							scanEventId: 9,
							createdAt: "2026-10-05T08:00:00Z",
							scanKind: "full",
							trigger: "button",
							site: "boutique.example",
							title: "Montre de luxe",
							score: 82,
							level: "high",
							fromCache: true,
							failed: false,
						},
					],
					actions: [
						{
							id: 5,
							action: "user.plan_set",
							adminUserId: "a1",
							adminEmail: "boss@radarnaque.test",
							targetUserId: "u1",
							createdAt: "2026-10-02T09:00:00Z",
							details: { from: null, to: "trial" },
						},
					],
				}),
			),
		);
		renderAt("/admin/utilisateurs/u1");

		expect(await screen.findByText("alice@radarnaque.test")).toBeTruthy();
		expect(screen.getByText("u1")).toBeTruthy();

		const active = screen.getByRole("region", { name: "Abonnement actif" });
		expect(within(active).getByText("trial")).toBeTruthy();
		expect(within(active).getByText("manual")).toBeTruthy();
		expect(within(active).getByText(/3 utilisées, 7 restantes/)).toBeTruthy();
		expect(within(active).getByText(/2 analyses effacées/)).toBeTruthy();

		const history = screen.getByRole("region", {
			name: "Historique des abonnements",
		});
		expect(within(history).getAllByRole("row")).toHaveLength(3);
		expect(within(history).getByText("expired")).toBeTruthy();

		const scans = screen.getByRole("region", { name: "Activité" });
		expect(within(scans).getByText("boutique.example")).toBeTruthy();
		expect(within(scans).getByText("Montre de luxe")).toBeTruthy();
		expect(within(scans).getByText("82")).toBeTruthy();
		expect(within(scans).getByText("cache")).toBeTruthy();

		const log = screen.getByRole("region", { name: "Journal" });
		expect(within(log).getByText("Plan attribué")).toBeTruthy();
		expect(within(log).getByText("boss@radarnaque.test")).toBeTruthy();
		expect(within(log).getByText("aucun → trial")).toBeTruthy();
	});

	it("assign plan confirms then refreshes the card", async () => {
		const { sent } = fakeFetch({
			...routeCard(card()),
			"POST /api/admin/users/u1/plan": () =>
				json(
					card({
						subscription: subscription({ id: 3, plan: "premium" }),
						subscriptions: [subscription({ id: 3, plan: "premium" })],
					}),
				),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		await user.selectOptions(
			screen.getByLabelText("Plan à attribuer"),
			"premium",
		);
		await user.click(screen.getByRole("button", { name: "Attribuer un plan" }));
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(
				"Plan actuel : trial. Le nouveau plan commence maintenant.",
			),
		).toBeTruthy();
		expect(sent("POST", "/api/admin/users/u1/plan")).toHaveLength(0);

		await user.click(within(dialog).getByRole("button", { name: "Attribuer" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(sent("POST", "/api/admin/users/u1/plan")[0].body).toEqual({
			plan: "premium",
		});
		const active = screen.getByRole("region", { name: "Abonnement actif" });
		expect(within(active).getByText("premium")).toBeTruthy();
	});

	it("stripe subscription disables plan assignment", async () => {
		fakeFetch(
			routeCard(
				card({
					subscription: subscription({ provider: "stripe", plan: "standard" }),
				}),
			),
		);
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");
		const button = screen.getByRole("button", {
			name: "Attribuer un plan",
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(screen.getByText("Géré dans Stripe")).toBeTruthy();
	});

	it("own card has no role or delete action", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/users/me1": () =>
				json(
					card({ id: "me1", email: "Admin@radarnaque.test", role: "admin" }),
				),
		});
		renderAt("/admin/utilisateurs/me1");
		await screen.findByText("Admin@radarnaque.test");
		expect(
			screen.getByRole("button", { name: "Attribuer un plan" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /rôle admin/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Nommer admin" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Supprimer le compte" }),
		).toBeNull();
	});

	it("delete requires the exact email and sends once", async () => {
		let release: () => void = () => {};
		const { sent } = fakeFetch({
			...routeCard(card()),
			"DELETE /api/admin/users/u1": async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return new Response(null, { status: 204 });
			},
			"GET /api/admin/users": () => json({ items: [], nextBefore: null }),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		await user.click(
			screen.getByRole("button", { name: "Supprimer le compte" }),
		);
		const dialog = await screen.findByRole("dialog");
		const confirm = within(dialog).getByRole("button", {
			name: "Supprimer",
		}) as HTMLButtonElement;
		const input = within(dialog).getByLabelText(/alice@radarnaque\.test/);
		expect(confirm.disabled).toBe(true);

		await user.type(input, "alice@radarnaque.tes");
		expect(confirm.disabled).toBe(true);
		await user.type(input, "t");
		expect(confirm.disabled).toBe(false);

		await user.dblClick(confirm);
		await waitFor(() =>
			expect(sent("DELETE", "/api/admin/users/u1")).toHaveLength(1),
		);
		release();
		await waitFor(() =>
			expect(window.location.pathname).toBe("/admin/utilisateurs"),
		);
		expect(sent("DELETE", "/api/admin/users/u1")).toHaveLength(1);
		expect(await screen.findByText("Aucun compte.")).toBeTruthy();
	});

	it("409 last admin shows the message", async () => {
		fakeFetch({
			...routeCard(card({ role: "admin" })),
			"POST /api/admin/users/u1/role": () =>
				apiError(409, "conflict", "Impossible de retirer le dernier admin.", {
					reason: "last_admin",
				}),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		await user.click(
			screen.getByRole("button", { name: "Retirer le rôle admin" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Retirer le rôle" }),
		);

		expect(
			await screen.findByText("Impossible : c'est le dernier admin."),
		).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("409 own account shows the message", async () => {
		fakeFetch({
			...routeCard(card()),
			"POST /api/admin/users/u1/role": () =>
				apiError(
					409,
					"conflict",
					"Vous ne pouvez pas modifier votre propre rôle.",
					{ reason: "self" },
				),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		await user.click(screen.getByRole("button", { name: "Nommer admin" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Nommer admin" }),
		);

		expect(
			await screen.findByText("Impossible sur votre propre compte."),
		).toBeTruthy();
	});

	it("409 stripe shows the message", async () => {
		fakeFetch({
			...routeCard(card()),
			"POST /api/admin/users/u1/plan": () =>
				apiError(409, "conflict", "Abonnement géré par Stripe.", {
					reason: "stripe",
				}),
		});
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		await user.click(screen.getByRole("button", { name: "Attribuer un plan" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Attribuer" }));
		expect(await screen.findByText("Géré dans Stripe.")).toBeTruthy();
	});

	it("user card plan menu comes from the API plans", async () => {
		fakeFetch({
			...routeCard(card()),
			"GET /api/admin/offer": () => offer(["trial", "standard", "gold"]),
		});
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		const menu = screen.getByLabelText("Plan à attribuer") as HTMLSelectElement;
		await waitFor(() =>
			expect([...menu.options].map((option) => option.value)).toEqual([
				"trial",
				"standard",
				"gold",
			]),
		);
		expect(menu.value).toBe("standard");
	});

	it("cancelling the confirmation sends nothing", async () => {
		const { sent } = fakeFetch(routeCard(card()));
		const user = userEvent.setup();
		renderAt("/admin/utilisateurs/u1");
		await screen.findByText("alice@radarnaque.test");

		await user.click(screen.getByRole("button", { name: "Nommer admin" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(sent("POST", "/api/admin/users/u1/role")).toHaveLength(0);
	});

	it("unknown account shows a message", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/users/zz": () =>
				apiError(404, "not_found", "Compte introuvable."),
		});
		renderAt("/admin/utilisateurs/zz");
		expect(await screen.findByText("Compte introuvable.")).toBeTruthy();
	});
});
