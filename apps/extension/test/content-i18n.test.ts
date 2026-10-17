import { describe, expect, test } from "vitest";
import {
	aiErrorText,
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
		expect(contentText("fr", "panel.footer")).toBe("Analyse locale, sans IA.");
		expect(contentText("nl", "panel.footer")).toBe(
			"Lokale analyse, zonder AI.",
		);
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

describe("textes de la section IA", () => {
	const aiKeys = (locale: "fr" | "nl") =>
		Object.keys(CONTENT_TEXTS[locale])
			.filter((key) => key.startsWith("ai."))
			.sort();

	test("parité exacte des clés ai.* entre FR et NL", () => {
		expect(aiKeys("fr").length).toBeGreaterThan(0);
		expect(aiKeys("nl")).toEqual(aiKeys("fr"));
	});

	test("les textes FR imposés", () => {
		const expected: Record<string, string> = {
			"ai.title": "Analyse IA",
			"ai.run": "Lancer une analyse IA",
			"ai.runPhotos": "Analyse avec photos",
			"ai.loading": "Analyse en cours…",
			"ai.accessLoading": "Chargement…",
			"ai.login": "Se connecter",
			"ai.loginHint": "Connectez-vous pour lancer une analyse IA.",
			"ai.loginFallback":
				"Cliquez sur l'icône Radarnaque dans la barre d'outils du navigateur pour vous connecter.",
			"ai.pricing": "Voir les formules",
			"ai.fromCache": "Résultat déjà disponible : servi depuis le cache.",
			"ai.partial":
				"Analyse partielle : seules les informations de la carte étaient disponibles.",
			"ai.remaining": "Analyses restantes : {count}",
			"ai.advice": "Conseil",
			"ai.reasons": "Pourquoi",
			"ai.error.session_expired": "Session expirée, reconnectez-vous.",
			"ai.error.unauthenticated": "Session expirée, reconnectez-vous.",
			"ai.error.no_active_subscription":
				"Un abonnement est nécessaire pour lancer une analyse IA.",
			"ai.error.quota_exhausted":
				"Vous avez utilisé toutes vos analyses de ce type pour cette période.",
			"ai.error.feature_not_in_plan":
				"Cette analyse n'est pas comprise dans votre formule.",
			"ai.error.invalid_listing":
				"Cette annonce ne peut pas être analysée (données illisibles).",
			"ai.error.rate_limited":
				"Trop d'analyses en peu de temps. Réessayez dans une minute.",
			"ai.error.analysis_failed":
				"L'analyse a échoué. Elle ne vous a pas été décomptée. Réessayez plus tard.",
			"ai.error.network": "Connexion impossible. Vérifiez votre réseau.",
			"ai.error.background_unavailable":
				"Connexion impossible. Vérifiez votre réseau.",
			"ai.error.default": "Une erreur est survenue. Réessayez plus tard.",
		};
		const fr = CONTENT_TEXTS.fr as Record<string, string>;
		for (const [key, text] of Object.entries(expected)) {
			expect(fr[key], key).toBe(text);
		}
		expect(aiKeys("fr")).toEqual(Object.keys(expected).sort());
	});

	test("ai.remaining garde {count} dans les deux langues", () => {
		expect(contentText("fr", "ai.remaining")).toContain("{count}");
		expect(contentText("nl", "ai.remaining")).toContain("{count}");
	});
});

describe("aiErrorText", () => {
	test("un code connu renvoie son texte dans la langue active", () => {
		expect(aiErrorText("fr", "quota_exhausted")).toBe(
			contentText("fr", "ai.error.quota_exhausted"),
		);
		expect(aiErrorText("nl", "rate_limited")).toBe(
			contentText("nl", "ai.error.rate_limited"),
		);
	});

	test("un code inconnu renvoie ai.error.default", () => {
		expect(aiErrorText("fr", "teapot")).toBe(
			"Une erreur est survenue. Réessayez plus tard.",
		);
		expect(aiErrorText("nl", "teapot")).toBe(
			contentText("nl", "ai.error.default"),
		);
	});

	test("un code qui ressemble à une clé non-erreur n'est pas résolu", () => {
		// `ai.error.` + code : jamais un accès à une clé hors du préfixe.
		expect(aiErrorText("fr", "../title")).toBe(
			contentText("fr", "ai.error.default"),
		);
		expect(aiErrorText("fr", "toString")).toBe(
			contentText("fr", "ai.error.default"),
		);
	});
});
