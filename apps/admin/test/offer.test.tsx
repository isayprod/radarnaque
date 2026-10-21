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
type Offer = Schemas["AdminOfferOut"];
type Plan = Schemas["OfferPlanOut"];

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

const PATCH_PREMIUM = "PATCH /api/admin/offer/plans/premium";
const PATCH_STANDARD = "PATCH /api/admin/offer/plans/standard";

function plans(): Plan[] {
	return [
		{
			code: "trial",
			quotaPeriod: "lifetime",
			quota: 3,
			totalScanCap: 3,
			maxImages: 4,
			cardIcons: false,
			prices: {},
		},
		{
			code: "standard",
			quotaPeriod: "subscription_month",
			quota: 30,
			totalScanCap: null,
			maxImages: 1,
			cardIcons: true,
			prices: {
				month: { amountCents: 499, stripePriceId: "price_std_month" },
				year: { amountCents: 4990, stripePriceId: null },
			},
		},
		{
			code: "premium",
			quotaPeriod: "subscription_month",
			quota: 300,
			totalScanCap: 5000,
			maxImages: 4,
			cardIcons: true,
			prices: {
				month: { amountCents: 999, stripePriceId: null },
				year: { amountCents: 9990, stripePriceId: null },
			},
		},
	];
}

function offer(over: Partial<Offer> = {}): Offer {
	return {
		plans: plans(),
		actions: [
			{
				id: 1,
				action: "offer.quota_set",
				adminUserId: "a1",
				adminEmail: "boss@radarnaque.test",
				targetUserId: null,
				createdAt: "2026-10-11T09:00:00Z",
				details: { plan: "premium", from: 200, to: 300 },
			},
			{
				id: 2,
				action: "offer.price_set",
				adminUserId: "a1",
				adminEmail: "boss@radarnaque.test",
				targetUserId: null,
				createdAt: "2026-10-10T09:00:00Z",
				details: { plan: "standard", interval: "month", from: 399, to: 499 },
			},
		],
		...over,
	};
}

/** L'offre avec les modifications données sur un plan. */
function withPlan(code: string, change: Partial<Plan>): Offer {
	return offer({
		plans: plans().map((p) => (p.code === code ? { ...p, ...change } : p)),
	});
}

function renderAt(path: string) {
	window.history.replaceState(null, "", path);
	return render(
		<SessionProvider>
			<App />
		</SessionProvider>,
	);
}

async function planForm(name: string) {
	return within(await screen.findByRole("region", { name: `Plan ${name}` }));
}

beforeEach(() => {
	window.history.replaceState(null, "", "/admin/offre");
});

afterEach(() => {
	cleanup();
});

describe("écran Offre", () => {
	it("forms show the offer and no price for trial", async () => {
		fakeFetch({ ...base, "GET /api/admin/offer": () => json(offer()) });
		renderAt("/admin/offre");

		const trial = await planForm("Essai");
		expect(trial.queryByLabelText(/Prix mensuel/)).toBeNull();
		expect(trial.queryByLabelText(/Prix annuel/)).toBeNull();
		expect(trial.getByLabelText("Quota")).toHaveProperty("value", "3");
		expect(trial.getByText("Total, à vie")).toBeTruthy();
		expect(trial.getByLabelText(/Plafond total/)).toHaveProperty("value", "3");
		expect(trial.getByLabelText(/Photos par analyse/)).toHaveProperty(
			"value",
			"4",
		);
		expect(trial.getByLabelText("Icônes sur les cartes")).toHaveProperty(
			"checked",
			false,
		);

		const standard = await planForm("Standard");
		expect(standard.getByLabelText(/Prix mensuel/)).toHaveProperty(
			"value",
			"4,99",
		);
		expect(standard.getByLabelText(/Prix annuel/)).toHaveProperty(
			"value",
			"49,90",
		);
		expect(standard.getByLabelText("Quota")).toHaveProperty("value", "30");
		expect(standard.getByText("Par mois d'abonnement")).toBeTruthy();
		expect(standard.getByLabelText(/Plafond total/)).toHaveProperty(
			"value",
			"",
		);
		expect(standard.getByLabelText(/Photos par analyse/)).toHaveProperty(
			"value",
			"1",
		);
		expect(standard.getByLabelText("Icônes sur les cartes")).toHaveProperty(
			"checked",
			true,
		);
		// L'identifiant Stripe est en lecture seule : du texte, pas un champ.
		expect(standard.getByText("price_std_month")).toBeTruthy();
		const save = standard.getByRole("button", {
			name: "Enregistrer",
		}) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
	});

	it("save sends only changed fields in cents", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/offer": () => json(offer()),
			[PATCH_STANDARD]: () => json(offer()),
		});
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const standard = await planForm("Standard");

		const month = standard.getByLabelText(/Prix mensuel/);
		await user.clear(month);
		await user.type(month, "2,99");
		await user.click(standard.getByRole("button", { name: "Enregistrer" }));
		const dialog = within(await screen.findByRole("dialog"));
		await user.click(dialog.getByRole("button", { name: "Enregistrer" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		expect(sent("PATCH", "/api/admin/offer/plans/standard")).toHaveLength(1);
		expect(sent("PATCH", "/api/admin/offer/plans/standard")[0].body).toEqual({
			prices: { month: 299 },
		});
	});

	it("prices are converted to whole cents without rounding error", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/offer": () => json(offer()),
			[PATCH_STANDARD]: () => json(offer()),
		});
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const standard = await planForm("Standard");

		// 1.15 * 100 vaut 114.99999999999999 en virgule flottante.
		const month = standard.getByLabelText(/Prix mensuel/);
		await user.clear(month);
		await user.type(month, "1.15");
		const year = standard.getByLabelText(/Prix annuel/);
		await user.clear(year);
		await user.type(year, " 19,9 ");
		await user.click(standard.getByRole("button", { name: "Enregistrer" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Enregistrer",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		expect(sent("PATCH", "/api/admin/offer/plans/standard")[0].body).toEqual({
			prices: { month: 115, year: 1990 },
		});
	});

	it("save sends no null except an emptied total cap", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/offer": () => json(offer()),
			[PATCH_PREMIUM]: () => json(withPlan("premium", { totalScanCap: null })),
		});
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");

		await user.clear(premium.getByLabelText(/Plafond total/));
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		const dialog = within(await screen.findByRole("dialog"));
		expect(
			dialog.getByText(/Plafond total Premium : 5000 → aucun/),
		).toBeTruthy();
		await user.click(dialog.getByRole("button", { name: "Enregistrer" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		expect(sent("PATCH", "/api/admin/offer/plans/premium")[0].body).toEqual({
			totalScanCap: null,
		});
	});

	it("confirmation lists the changes", async () => {
		fakeFetch({ ...base, "GET /api/admin/offer": () => json(offer()) });
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");

		await user.clear(premium.getByLabelText("Quota"));
		await user.type(premium.getByLabelText("Quota"), "400");
		await user.clear(premium.getByLabelText(/Photos par analyse/));
		await user.type(premium.getByLabelText(/Photos par analyse/), "3");
		await user.click(premium.getByLabelText("Icônes sur les cartes"));
		const month = premium.getByLabelText(/Prix mensuel/);
		await user.clear(month);
		await user.type(month, "12,5");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));

		const dialog = within(await screen.findByRole("dialog"));
		expect(dialog.getByText(/Quota Premium : 300 → 400/)).toBeTruthy();
		expect(dialog.getByText(/Photos par analyse Premium : 4 → 3/)).toBeTruthy();
		expect(
			dialog.getByText(/Icônes sur les cartes Premium : oui → non/),
		).toBeTruthy();
		expect(
			dialog.getByText(/Prix mensuel Premium : 9,99\s€ → 12,50\s€/),
		).toBeTruthy();
		// Les champs non modifiés n'y figurent pas.
		expect(dialog.queryByText(/Prix annuel/)).toBeNull();
		expect(dialog.queryByText(/Plafond/)).toBeNull();

		await user.click(dialog.getByRole("button", { name: "Annuler" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stripe warning on price change", async () => {
		fakeFetch({ ...base, "GET /api/admin/offer": () => json(offer()) });
		const user = userEvent.setup();
		renderAt("/admin/offre");

		// Standard : le prix mensuel a un identifiant Stripe.
		const standard = await planForm("Standard");
		const month = standard.getByLabelText(/Prix mensuel/);
		await user.clear(month);
		await user.type(month, "5,99");
		await user.click(standard.getByRole("button", { name: "Enregistrer" }));
		let dialog = within(await screen.findByRole("dialog"));
		expect(
			dialog.getByText(/Créez aussi le nouveau prix dans Stripe\./),
		).toBeTruthy();
		await user.click(dialog.getByRole("button", { name: "Annuler" }));

		// Le prix annuel du Standard et les prix du Premium n'en ont pas.
		const year = standard.getByLabelText(/Prix annuel/);
		await user.clear(month);
		await user.type(month, "4,99");
		await user.clear(year);
		await user.type(year, "59");
		await user.click(standard.getByRole("button", { name: "Enregistrer" }));
		dialog = within(await screen.findByRole("dialog"));
		expect(dialog.queryByText(/Stripe/)).toBeNull();
		await user.click(dialog.getByRole("button", { name: "Annuler" }));

		const premium = await planForm("Premium");
		const premiumMonth = premium.getByLabelText(/Prix mensuel/);
		await user.clear(premiumMonth);
		await user.type(premiumMonth, "10");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		dialog = within(await screen.findByRole("dialog"));
		expect(dialog.queryByText(/Stripe/)).toBeNull();
	});

	it("privacy warning on photos change", async () => {
		fakeFetch({ ...base, "GET /api/admin/offer": () => json(offer()) });
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");

		await user.clear(premium.getByLabelText("Quota"));
		await user.type(premium.getByLabelText("Quota"), "400");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		let dialog = within(await screen.findByRole("dialog"));
		expect(dialog.queryByText(/\/privacy/)).toBeNull();
		await user.click(dialog.getByRole("button", { name: "Annuler" }));

		await user.clear(premium.getByLabelText(/Photos par analyse/));
		await user.type(premium.getByLabelText(/Photos par analyse/), "2");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		dialog = within(await screen.findByRole("dialog"));
		expect(
			dialog.getByText(
				/Pensez à mettre à jour la page \/privacy, qui annonce 1 photo en Standard et jusqu'à 4 en Premium et pendant l'essai\./,
			),
		).toBeTruthy();
	});

	it("out of bounds value cannot be saved", async () => {
		fakeFetch({ ...base, "GET /api/admin/offer": () => json(offer()) });
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");
		const save = premium.getByRole("button", {
			name: "Enregistrer",
		}) as HTMLButtonElement;

		async function invalid(label: string | RegExp, text: string) {
			const input = premium.getByLabelText(label);
			const before = (input as HTMLInputElement).value;
			await user.clear(input);
			if (text) await user.type(input, text);
			expect(input.getAttribute("aria-invalid"), text).toBe("true");
			expect(save.disabled, text).toBe(true);
			// Un autre champ valide et modifié ne débloque pas l'enregistrement.
			await user.click(premium.getByLabelText("Icônes sur les cartes"));
			expect(save.disabled, text).toBe(true);
			await user.click(premium.getByLabelText("Icônes sur les cartes"));
			await user.clear(input);
			await user.type(input, before);
			expect(input.getAttribute("aria-invalid")).toBe("false");
		}

		await invalid(/Photos par analyse/, "5");
		await invalid("Quota", "-1");
		await invalid("Quota", "100001");
		await invalid("Quota", "");
		await invalid("Quota", "1,5");
		await invalid(/Plafond total/, "100001");
		await invalid(/Prix mensuel/, "abc");
		await invalid(/Prix mensuel/, "1000,01");
		await invalid(/Prix mensuel/, "2,999");
		await invalid(/Prix mensuel/, "-1");
		await invalid(/Prix mensuel/, "");
		await invalid(/Prix annuel/, "1,2,3");
		expect(save.disabled).toBe(true);
	});

	it("price bounds are 0 and 1000 euros", async () => {
		const { sent } = fakeFetch({
			...base,
			"GET /api/admin/offer": () => json(offer()),
			[PATCH_PREMIUM]: () => json(offer()),
		});
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");

		const month = premium.getByLabelText(/Prix mensuel/);
		await user.clear(month);
		await user.type(month, "0");
		const year = premium.getByLabelText(/Prix annuel/);
		await user.clear(year);
		await user.type(year, "1000");
		expect(month.getAttribute("aria-invalid")).toBe("false");
		expect(year.getAttribute("aria-invalid")).toBe("false");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Enregistrer",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(sent("PATCH", "/api/admin/offer/plans/premium")[0].body).toEqual({
			prices: { month: 0, year: 100000 },
		});
	});

	it("after save the screen shows the API offer and clears drafts", async () => {
		const after = withPlan("premium", { quota: 350, maxImages: 3 });
		after.actions = [
			{
				id: 3,
				action: "offer.quota_set",
				adminUserId: "a1",
				adminEmail: "boss@radarnaque.test",
				targetUserId: null,
				createdAt: "2026-10-12T09:00:00Z",
				details: { plan: "premium", from: 300, to: 350 },
			},
			...offer().actions,
		];
		fakeFetch({
			...base,
			"GET /api/admin/offer": () => json(offer()),
			[PATCH_PREMIUM]: () => json(after),
		});
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");
		const standard = await planForm("Standard");

		// Un brouillon d'un autre plan n'est pas touché par l'enregistrement du Premium.
		await user.clear(standard.getByLabelText("Quota"));
		await user.type(standard.getByLabelText("Quota"), "45");

		await user.clear(premium.getByLabelText("Quota"));
		await user.type(premium.getByLabelText("Quota"), "400");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Enregistrer",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		// Le serveur fait foi (350, pas le 400 saisi) ; plus de brouillon à enregistrer.
		await waitFor(() =>
			expect(premium.getByLabelText("Quota")).toHaveProperty("value", "350"),
		);
		expect(premium.getByLabelText(/Photos par analyse/)).toHaveProperty(
			"value",
			"3",
		);
		expect(
			(
				premium.getByRole("button", {
					name: "Enregistrer",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(standard.getByLabelText("Quota")).toHaveProperty("value", "45");
		// L'historique est celui de la réponse.
		const history = within(screen.getByRole("region", { name: "Historique" }));
		expect(history.getAllByRole("row")).toHaveLength(4);
		expect(history.getByText("300 → 350", { exact: false })).toBeTruthy();
	});

	it("a failed save shows the message and keeps the drafts", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/offer": () => json(offer()),
			[PATCH_PREMIUM]: () =>
				apiError(422, "invalid_value", "Quota hors limites."),
		});
		const user = userEvent.setup();
		renderAt("/admin/offre");
		const premium = await planForm("Premium");

		await user.clear(premium.getByLabelText("Quota"));
		await user.type(premium.getByLabelText("Quota"), "400");
		await user.click(premium.getByRole("button", { name: "Enregistrer" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Enregistrer",
			}),
		);

		expect(await premium.findByRole("alert")).toHaveProperty(
			"textContent",
			"Quota hors limites.",
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(premium.getByLabelText("Quota")).toHaveProperty("value", "400");
	});

	it("history lists offer actions", async () => {
		fakeFetch({ ...base, "GET /api/admin/offer": () => json(offer()) });
		renderAt("/admin/offre");

		const history = within(
			await screen.findByRole("region", { name: "Historique" }),
		);
		expect(history.getByText("Quota modifié")).toBeTruthy();
		expect(history.getByText("premium : 200 → 300")).toBeTruthy();
		expect(history.getByText("Prix modifié")).toBeTruthy();
		expect(
			history.getByText(/standard, mois : 3,99\s€ → 4,99\s€/),
		).toBeTruthy();
		expect(history.getAllByText("boss@radarnaque.test")).toHaveLength(2);
	});

	it("a failed read shows an error", async () => {
		fakeFetch({
			...base,
			"GET /api/admin/offer": () => apiError(500, "internal", "Erreur."),
		});
		renderAt("/admin/offre");
		expect(
			await screen.findByText("Impossible de charger l'offre."),
		).toBeTruthy();
	});
});
