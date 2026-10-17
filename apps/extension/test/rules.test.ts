import { describe, expect, test } from "vitest";
import type { Listing } from "../lib/listing/types";
import type { RuleId } from "../lib/rules/rules";
import { RULES, RULES_VERSION } from "../lib/rules/rules";
import type { UnknownField } from "../lib/rules/score";
import { evaluate, levelOf } from "../lib/rules/score";

const NEUTRAL_DESCRIPTION =
	"Très bon état, vendu car plus utilisé, visible sur place à Bruxelles en semaine.";

function makeListing(overrides: Partial<Listing> = {}): Listing {
	return {
		site: "2ememain.be",
		externalId: "m1",
		url: "https://www.2ememain.be/a/m1.html",
		title: "Vélo de ville",
		description: NEUTRAL_DESCRIPTION,
		price: { amountCents: 5000, currency: "EUR" },
		priceType: "fixed",
		location: { city: "Bruxelles", country: "BE" },
		images: ["https://img/1.jpg", "https://img/2.jpg", "https://img/3.jpg"],
		seller: {},
		...overrides,
	};
}

function ids(listing: Listing): RuleId[] {
	return evaluate(listing).signals.map((s) => s.id);
}

function signal(listing: Listing, id: RuleId) {
	return evaluate(listing).signals.find((s) => s.id === id);
}

describe("neutral listing", () => {
	test("the factory description is 80 characters", () => {
		expect(NEUTRAL_DESCRIPTION.length).toBe(80);
	});

	test("triggers nothing", () => {
		expect(evaluate(makeListing())).toEqual({
			score: 0,
			level: "low",
			signals: [],
			rulesVersion: RULES_VERSION,
		});
	});
});

describe("registry", () => {
	test("is ordered as the rules table", () => {
		expect(RULES.map((r) => r.id)).toEqual([
			"few_photos",
			"new_account",
			"no_reviews",
			"foreign_location",
			"short_description",
			"contact_outside",
			"shipping_only",
			"offsite_payment",
			"symbolic_price",
			"price_anomaly",
		]);
		expect(RULES_VERSION).toBe(1);
	});

	test("weights and severities match the table", () => {
		const table = RULES.filter((r) => r.id !== "price_anomaly").map((r) => [
			r.id,
			r.weight,
			r.severity,
		]);
		expect(table).toEqual([
			["few_photos", 15, "warning"],
			["new_account", 25, "danger"],
			["no_reviews", 10, "warning"],
			["foreign_location", 20, "warning"],
			["short_description", 10, "info"],
			["contact_outside", 25, "danger"],
			["shipping_only", 15, "warning"],
			["offsite_payment", 35, "danger"],
			["symbolic_price", 20, "warning"],
		]);
	});

	test("price_anomaly is disabled and never appears", () => {
		const rule = RULES.find((r) => r.id === "price_anomaly");
		expect(rule?.enabled).toBe(false);
		const worst = makeListing({
			images: [],
			description: "",
			price: { amountCents: 0, currency: "EUR" },
		});
		expect(ids(worst)).not.toContain("price_anomaly");
	});
});

describe("few_photos", () => {
	test("positive with 0 and 1 image, with count param", () => {
		expect(signal(makeListing({ images: [] }), "few_photos")?.params).toEqual({
			count: 0,
		});
		const one = signal(
			makeListing({ images: ["https://img/1.jpg"] }),
			"few_photos",
		);
		expect(one).toEqual({
			id: "few_photos",
			weight: 15,
			severity: "warning",
			params: { count: 1 },
		});
	});

	test("negative with 2 images", () => {
		expect(ids(makeListing({ images: ["a", "b"] }))).not.toContain(
			"few_photos",
		);
	});
});

describe("new_account", () => {
	test("positive when the upper bound is under 3 months", () => {
		const l = makeListing({ seller: { accountAgeMonths: { min: 0, max: 2 } } });
		expect(ids(l)).toEqual(["new_account"]);
		expect(evaluate(l).score).toBe(25);
	});

	test("negative when max is 3 or more", () => {
		const l = makeListing({ seller: { accountAgeMonths: { min: 0, max: 3 } } });
		expect(ids(l)).not.toContain("new_account");
	});

	test("unknown age triggers nothing", () => {
		expect(ids(makeListing({ seller: {} }))).not.toContain("new_account");
	});
});

describe("no_reviews", () => {
	test("positive at exactly 0 reviews", () => {
		expect(ids(makeListing({ seller: { reviewCount: 0 } }))).toEqual([
			"no_reviews",
		]);
	});

	test("negative with reviews", () => {
		expect(ids(makeListing({ seller: { reviewCount: 4 } }))).toEqual([]);
	});

	test("unknown review count triggers nothing", () => {
		expect(ids(makeListing({ seller: { rating: 5 } }))).toEqual([]);
	});
});

describe("foreign_location", () => {
	test("positive outside Belgium, with country param", () => {
		const s = signal(
			makeListing({ location: { country: "FR" } }),
			"foreign_location",
		);
		expect(s).toEqual({
			id: "foreign_location",
			weight: 20,
			severity: "warning",
			params: { country: "FR" },
		});
	});

	test("negative in Belgium", () => {
		expect(ids(makeListing({ location: { country: "BE" } }))).toEqual([]);
	});

	test("unknown country triggers nothing", () => {
		expect(ids(makeListing({ location: { city: "Paris" } }))).toEqual([]);
	});
});

describe("short_description", () => {
	test("positive under 30 characters after trim", () => {
		expect(ids(makeListing({ description: "  Vélo en bon état.   " }))).toEqual(
			["short_description"],
		);
		expect(ids(makeListing({ description: "" }))).toEqual([
			"short_description",
		]);
	});

	test("negative at 30 characters", () => {
		expect(ids(makeListing({ description: "a".repeat(30) }))).toEqual([]);
	});
});

describe("contact_outside", () => {
	function kindOf(
		text: string,
		where: "description" | "title" = "description",
	) {
		const base = makeListing();
		const l =
			where === "title"
				? { ...base, title: text }
				: { ...base, description: `${NEUTRAL_DESCRIPTION} ${text}` };
		return signal(l, "contact_outside")?.params?.kind;
	}

	test("Belgian mobile numbers", () => {
		expect(kindOf("Appelez le 0472 12 34 56 svp")).toBe("phone");
		expect(kindOf("Appelez le 0472123456")).toBe("phone");
		expect(kindOf("Bel 0472/12.34.56")).toBe("phone");
		expect(kindOf("Tel +32 472 12 34 56")).toBe("phone");
		expect(kindOf("Tel 0032 472 12 34 56")).toBe("phone");
	});

	test("international numbers", () => {
		expect(kindOf("Call +33 61 23 45 67 89")).toBe("phone");
	});

	test("number in the title", () => {
		expect(kindOf("Vélo 0472 12 34 56", "title")).toBe("phone");
	});

	test("email", () => {
		expect(kindOf("Écrivez-moi : Jean.Dupont@example.com")).toBe("email");
	});

	test("apps FR and NL", () => {
		expect(kindOf("Contactez-moi sur WhatsApp")).toBe("app");
		expect(kindOf("ecris-moi sur whats app")).toBe("app");
		expect(kindOf("wa.me/32472123456")).toBe("app");
		expect(kindOf("Stuur een bericht op Telegram")).toBe("app");
		expect(kindOf("t.me/vendeur")).toBe("app");
		expect(kindOf("contactez-moi via signal")).toBe("app");
		expect(kindOf("Contacteer me op signal")).toBe("app");
		expect(kindOf("Reach me on Signal app")).toBe("app");
		expect(kindOf("mail me sur signal")).toBe("app");
	});

	test("score contribution", () => {
		const l = makeListing({ description: `${NEUTRAL_DESCRIPTION} whatsapp` });
		expect(evaluate(l).score).toBe(25);
	});

	test("negative on a neutral listing", () => {
		expect(ids(makeListing())).not.toContain("contact_outside");
	});

	test("false positives: plain signal word and prices", () => {
		expect(kindOf("signal sonore OK")).toBeUndefined();
		expect(kindOf("Le signal est bon")).toBeUndefined();
		expect(kindOf("Prix 1 234 € à débattre")).toBeUndefined();
		expect(kindOf("Prix 1 234 € ou 8 500 €")).toBeUndefined();
		expect(kindOf("Prix 12 345,00 €")).toBeUndefined();
	});

	test("empty text does not trigger contact_outside", () => {
		expect(ids(makeListing({ title: "", description: "" }))).toEqual([
			"short_description",
		]);
	});

	test("generic product text and measures are not phone numbers", () => {
		for (const text of [
			"iPhone 14 PRO 128GB",
			"Canon EOS 3000D 2018",
			"Année 2015, 85000 km",
			"1000 Bruxelles",
			"120x60x45 cm",
			"Prix 8\u00a0500 €",
			"Prix € 23\u202f500",
			"Prix 8 500 €",
			"Prix € 23 500",
			"+15 °C à +25 °C",
			"+50 000 km",
			"S23+ 256",
			"+10 20 30 40",
			"+20 000 000",
			"ean 0472123456789",
		]) {
			expect(kindOf(text), text).toBeUndefined();
		}
	});

	test("more phone formats", () => {
		for (const text of [
			"+33 6 12 34 56 78",
			"+32 4 123 45 67",
			"+31 6 12345678",
			"+33612345678",
			"+49 151 23456789",
			"0472 123 456",
			"0472/123.456",
			"gsm 0472 123 456",
			"0472 12 34 56",
			"0472123456",
		]) {
			expect(kindOf(text), text).toBe("phone");
		}
	});

	test("app domains need a left word boundary", () => {
		expect(kindOf("fact.me/xyz")).toBeUndefined();
		expect(kindOf("voir exact.me/xyz")).toBeUndefined();
		expect(kindOf("contact wa.me/32472123456")).toBe("app");
		expect(kindOf("(t.me/vendeur)")).toBe("app");
	});
});

describe("shipping_only", () => {
	test.each([
		"Envoi uniquement, merci",
		"Pas de remise en main propre",
		"PAS DE REMISE EN MAIN PROPRE",
		"Alleen verzenden",
		"Geen ophalen mogelijk",
		"Shipping only",
	])("positive: %s", (text) => {
		const l = makeListing({ description: `${NEUTRAL_DESCRIPTION} ${text}` });
		expect(ids(l)).toEqual(["shipping_only"]);
	});

	test("negative", () => {
		const l = makeListing({
			description: `${NEUTRAL_DESCRIPTION} Envoi possible ou main propre.`,
		});
		expect(ids(l)).toEqual([]);
	});

	test("also reads the title", () => {
		expect(ids(makeListing({ title: "Vélo shipping only" }))).toEqual([
			"shipping_only",
		]);
	});
});

describe("offsite_payment", () => {
	test.each([
		"Western Union uniquement",
		"MoneyGram",
		"Paiement à l'avance requis",
		"paiement a l'avance",
		"Paiement à l’avance",
		"paiement à lʼavance",
		"paiement à l´avance",
		"paiement à l`avance",
		"Vooraf betalen graag",
		"Je krijgt een betaallink",
		"Envoyez un lien de paiement",
		"PayPal amis",
		"PayPal vrienden",
		"paypal friends and family",
		"Payconiq vooraf",
	])("positive: %s", (text) => {
		const l = makeListing({ description: `${NEUTRAL_DESCRIPTION} ${text}` });
		const s = signal(l, "offsite_payment");
		expect(s).toEqual({
			id: "offsite_payment",
			weight: 35,
			severity: "danger",
		});
	});

	test("negative", () => {
		const l = makeListing({
			description: `${NEUTRAL_DESCRIPTION} Paiement en espèces à la remise.`,
		});
		expect(ids(l)).toEqual([]);
	});

	test("unknown (no text) triggers nothing", () => {
		expect(ids(makeListing({ title: "" }))).toEqual([]);
	});

	test("friends and family needs paypal in the same text", () => {
		const idsOf = (text: string) =>
			ids(makeListing({ description: `${NEUTRAL_DESCRIPTION} ${text}` }));
		expect(idsOf("Ideal for friends and family")).toEqual([]);
		expect(idsOf("PayPal, friends and family")).toEqual(["offsite_payment"]);
		expect(
			ids(
				makeListing({
					title: "PayPal only",
					description: `${NEUTRAL_DESCRIPTION} friends and family`,
				}),
			),
		).toEqual(["offsite_payment"]);
	});
});

describe("symbolic_price", () => {
	test("positive from 0 to 100 cents", () => {
		for (const amountCents of [0, 1, 100]) {
			const l = makeListing({ price: { amountCents, currency: "EUR" } });
			expect(ids(l)).toEqual(["symbolic_price"]);
		}
	});

	test("negative above 1 euro", () => {
		const l = makeListing({ price: { amountCents: 101, currency: "EUR" } });
		expect(ids(l)).toEqual([]);
	});

	test("not triggered when priceType is free", () => {
		const l = makeListing({
			price: { amountCents: 0, currency: "EUR" },
			priceType: "free",
		});
		expect(ids(l)).toEqual([]);
	});

	test("not triggered when price is null", () => {
		expect(ids(makeListing({ price: null, priceType: "unknown" }))).toEqual([]);
		expect(ids(makeListing({ price: null, priceType: "fixed" }))).toEqual([]);
	});
});

describe("score and level", () => {
	test("is additive: few_photos + new_account = 40, medium", () => {
		const l = makeListing({
			images: ["a"],
			seller: { accountAgeMonths: { min: 0, max: 1 } },
		});
		const report = evaluate(l);
		expect(report.score).toBe(40);
		expect(report.level).toBe("medium");
		expect(report.signals.map((s) => s.id)).toEqual([
			"few_photos",
			"new_account",
		]);
	});

	test("is capped at 100 with every active rule", () => {
		const l = makeListing({
			images: [],
			title: "Vélo envoi uniquement",
			description: "whatsapp western union",
			price: { amountCents: 0, currency: "EUR" },
			location: { country: "FR" },
			seller: { reviewCount: 0, accountAgeMonths: { min: 0, max: 0 } },
		});
		const report = evaluate(l);
		expect(report.signals).toHaveLength(9);
		expect(report.signals.reduce((n, s) => n + s.weight, 0)).toBe(175);
		expect(report.score).toBe(100);
		expect(report.level).toBe("high");
	});

	test("ignores rules disabled in the registry", () => {
		const rule = RULES.find((r) => r.id === "few_photos");
		if (!rule) throw new Error("missing rule");
		rule.enabled = false;
		try {
			expect(ids(makeListing({ images: [] }))).toEqual([]);
		} finally {
			rule.enabled = true;
		}
	});

	test("unknown description skips short_description", () => {
		const l = makeListing({ description: "" });
		expect(ids(l)).toEqual(["short_description"]);
		const unknown = new Set<UnknownField>(["description"]);
		expect(evaluate(l, { unknown }).signals).toEqual([]);
		expect(evaluate(l, { unknown: new Set() }).signals).toHaveLength(1);
	});

	test("unknown images skips few_photos", () => {
		const l = makeListing({ images: [] });
		expect(ids(l)).toEqual(["few_photos"]);
		const unknown = new Set<UnknownField>(["images"]);
		expect(evaluate(l, { unknown }).signals).toEqual([]);
	});

	test("unknown fields do not disable other rules", () => {
		const l = makeListing({ images: [], description: "whatsapp" });
		const unknown = new Set<UnknownField>(["description", "images"]);
		expect(evaluate(l, { unknown }).signals.map((s) => s.id)).toEqual([
			"contact_outside",
		]);
	});

	test("levelOf thresholds", () => {
		expect(levelOf(0)).toBe("low");
		expect(levelOf(29)).toBe("low");
		expect(levelOf(30)).toBe("medium");
		expect(levelOf(59)).toBe("medium");
		expect(levelOf(60)).toBe("high");
		expect(levelOf(100)).toBe("high");
	});
});
