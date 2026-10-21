// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOffer, parseOffer } from "../src/offer";
import { PLANS } from "../src/pages-i18n";

const plan = (over: Record<string, unknown> = {}) => ({
	scans: 150,
	maxImages: 1,
	cardIcons: false,
	monthlyCents: 299,
	yearlyCents: 2900,
	...over,
});

const body = (over: Record<string, unknown> = {}) => ({
	trial: plan({
		scans: 3,
		maxImages: 4,
		cardIcons: true,
		monthlyCents: null,
		yearlyCents: null,
	}),
	standard: plan(),
	premium: plan({
		scans: 400,
		maxImages: 4,
		cardIcons: true,
		monthlyCents: 699,
		yearlyCents: 6900,
	}),
	...over,
});

const reply = (status: number, json: unknown) =>
	vi.fn(async () => new Response(JSON.stringify(json), { status }));

describe("PLANS (valeurs de secours)", () => {
	it("reprend l'offre actuelle", () => {
		expect(PLANS).toEqual({
			trial: {
				scans: 3,
				maxImages: 4,
				cardIcons: true,
				monthlyCents: null,
				yearlyCents: null,
			},
			standard: {
				scans: 150,
				maxImages: 1,
				cardIcons: false,
				monthlyCents: 299,
				yearlyCents: 2900,
			},
			premium: {
				scans: 300,
				maxImages: 4,
				cardIcons: true,
				monthlyCents: 699,
				yearlyCents: 6900,
			},
		});
	});
});

describe("parseOffer", () => {
	it("accepte la réponse de l'API", () => {
		expect(parseOffer(body())).toEqual(body());
	});

	it("ignore les champs inconnus", () => {
		const parsed = parseOffer(body({ extra: 1, standard: plan({ x: "y" }) }));
		expect(parsed).toEqual(body());
	});

	it("refuse un JSON incomplet", () => {
		expect(parseOffer({ trial: plan(), standard: plan() })).toBeNull();
		expect(parseOffer(body({ premium: { scans: 1 } }))).toBeNull();
		expect(
			parseOffer(body({ standard: { ...plan(), monthlyCents: undefined } })),
		).toBeNull();
	});

	it("refuse un nombre négatif ou non entier", () => {
		expect(parseOffer(body({ standard: plan({ scans: -1 }) }))).toBeNull();
		expect(parseOffer(body({ standard: plan({ maxImages: -2 }) }))).toBeNull();
		expect(
			parseOffer(body({ standard: plan({ monthlyCents: -299 }) })),
		).toBeNull();
		expect(parseOffer(body({ standard: plan({ scans: 1.5 }) }))).toBeNull();
	});

	it("refuse un type faux", () => {
		expect(parseOffer(body({ standard: plan({ scans: "150" }) }))).toBeNull();
		expect(
			parseOffer(body({ premium: plan({ cardIcons: "true" }) })),
		).toBeNull();
		expect(
			parseOffer(body({ premium: plan({ yearlyCents: "6900" }) })),
		).toBeNull();
		expect(parseOffer(body({ premium: null }))).toBeNull();
		expect(parseOffer(null)).toBeNull();
		expect(parseOffer("offre")).toBeNull();
		expect(parseOffer([])).toBeNull();
	});

	it("accepte un prix absent (null) pour un plan payant", () => {
		const parsed = parseOffer(body({ standard: plan({ monthlyCents: null }) }));
		expect(parsed?.standard.monthlyCents).toBeNull();
	});
});

describe("fetchOffer", () => {
	it("lit /api/offer et renvoie l'offre", async () => {
		const f = reply(200, body());
		expect(await fetchOffer(f)).toEqual(body());
		expect(f).toHaveBeenCalledWith("/api/offer");
	});

	it("renvoie null sur un rejet réseau", async () => {
		const f = vi.fn(async () => {
			throw new TypeError("réseau coupé");
		});
		expect(await fetchOffer(f)).toBeNull();
	});

	it("renvoie null sur un statut 500", async () => {
		expect(await fetchOffer(reply(500, body()))).toBeNull();
	});

	it("renvoie null sur un statut 2xx autre que 200", async () => {
		expect(await fetchOffer(reply(204, null))).toBeNull();
	});

	it("renvoie null sur un corps de forme inattendue", async () => {
		expect(await fetchOffer(reply(200, { trial: 1 }))).toBeNull();
	});

	it("renvoie null sur un corps qui n'est pas du JSON", async () => {
		const f = vi.fn(async () => new Response("<html>", { status: 200 }));
		expect(await fetchOffer(f)).toBeNull();
	});
});

describe("pricing.ts (point d'entrée)", () => {
	beforeEach(() => {
		document.body.innerHTML = '<main id="app"></main>';
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const text = () => document.getElementById("app")?.textContent ?? "";
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("rend les valeurs de secours tout de suite, puis l'offre de l'API", async () => {
		let release: (res: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>((r) => (release = r))),
		);
		await import("../src/pricing");
		expect(text()).toContain("300 analyses par mois");
		release(new Response(JSON.stringify(body()), { status: 200 }));
		await settle();
		expect(text()).toContain("400 analyses par mois");
		expect(text()).not.toContain("300 analyses par mois");
	});

	it("garde les valeurs de secours quand l'API est en panne", async () => {
		vi.stubGlobal("fetch", reply(500, {}));
		await import("../src/pricing");
		await settle();
		expect(text()).toContain("300 analyses par mois");
		expect(document.querySelectorAll("article.plan")).toHaveLength(3);
	});

	it("garde les valeurs de secours quand le réseau échoue", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("réseau coupé");
			}),
		);
		await import("../src/pricing");
		await settle();
		expect(text()).toContain("300 analyses par mois");
	});
});
