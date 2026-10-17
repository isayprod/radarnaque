import { describe, expect, test } from "vitest";
import {
	CONTENT_TEXTS,
	contentText,
	resolveContentLocale,
	signalText,
} from "../lib/content-i18n";
import { RULES } from "../lib/rules/rules";

describe("parité FR/NL", () => {
	test("les clés FR et NL sont identiques", () => {
		expect(Object.keys(CONTENT_TEXTS.nl).sort()).toEqual(
			Object.keys(CONTENT_TEXTS.fr).sort(),
		);
	});

	test("aucun texte n'est vide", () => {
		for (const locale of ["fr", "nl"] as const) {
			for (const text of Object.values(CONTENT_TEXTS[locale])) {
				expect(text.trim()).not.toBe("");
			}
		}
	});

	test("chaque règle activée a un texte dans les deux langues", () => {
		for (const rule of RULES.filter((r) => r.enabled)) {
			expect(CONTENT_TEXTS.fr).toHaveProperty(rule.id);
			expect(CONTENT_TEXTS.nl).toHaveProperty(rule.id);
		}
	});
});

describe("contentText", () => {
	test("renvoie les textes imposés", () => {
		expect(contentText("fr", "level.high")).toBe("Risque élevé");
		expect(contentText("nl", "level.high")).toBe("Hoog risico");
		expect(contentText("fr", "badge.aria")).toBe("Ouvrir l'analyse Radarnaque");
		expect(contentText("nl", "panel.title")).toBe("Radarnaque-analyse");
	});
});

describe("signalText", () => {
	test("interpole {count}", () => {
		const signal = {
			id: "few_photos",
			weight: 15,
			severity: "warning",
			params: { count: 1 },
		} as const;
		expect(signalText("fr", signal)).toBe("Peu de photos (1)");
		expect(signalText("nl", signal)).toBe("Weinig foto's (1)");
	});

	test("interpole {country}", () => {
		const signal = {
			id: "foreign_location",
			weight: 20,
			severity: "warning",
			params: { country: "FR" },
		} as const;
		expect(signalText("fr", signal)).toBe(
			"Vendeur situé hors de Belgique (FR)",
		);
		expect(signalText("nl", signal)).toBe("Verkoper buiten België (FR)");
	});

	test("un paramètre manquant retire le placeholder proprement", () => {
		expect(
			signalText("fr", { id: "few_photos", weight: 15, severity: "warning" }),
		).toBe("Peu de photos");
		expect(
			signalText("nl", {
				id: "foreign_location",
				weight: 20,
				severity: "warning",
			}),
		).toBe("Verkoper buiten België");
	});

	test("un signal sans placeholder est renvoyé tel quel", () => {
		expect(
			signalText("fr", { id: "new_account", weight: 25, severity: "danger" }),
		).toBe("Compte vendeur très récent");
	});

	test("price_anomaly (désactivée) renvoie une chaîne vide sans lever", () => {
		expect(
			signalText("fr", { id: "price_anomaly", weight: 0, severity: "info" }),
		).toBe("");
	});
});

describe("resolveContentLocale", () => {
	test("la préférence l'emporte", () => {
		expect(resolveContentLocale("2dehands.be", "fr", "nl-BE")).toBe("fr");
		expect(resolveContentLocale("2ememain.be", "nl", "fr-BE")).toBe("nl");
		expect(resolveContentLocale("facebook.com", "fr", "nl-BE")).toBe("fr");
	});

	test("2dehands donne nl, 2ememain donne fr", () => {
		expect(resolveContentLocale("2dehands.be", null, "fr-FR")).toBe("nl");
		expect(resolveContentLocale("2ememain.be", null, "nl-BE")).toBe("fr");
	});

	test("Facebook suit la langue du navigateur", () => {
		expect(resolveContentLocale("facebook.com", null, "nl-BE")).toBe("nl");
		expect(resolveContentLocale("facebook.com", null, "NL")).toBe("nl");
		expect(resolveContentLocale("facebook.com", null, "en-US")).toBe("fr");
		expect(resolveContentLocale("facebook.com", null, "")).toBe("fr");
	});
});
