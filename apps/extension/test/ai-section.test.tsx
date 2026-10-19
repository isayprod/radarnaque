import type { AnalysisResult } from "@radarnaque/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AiSection } from "../components/AiSection";
import type { ScanState } from "../lib/content/ai-client";
import { startProgress } from "../lib/content/scan-progress";
import { shownResult } from "../lib/content/shown-result";
import { contentText } from "../lib/content-i18n";
import type { ContentAccess } from "../lib/messages";

afterEach(cleanup);

const PRICING = "http://localhost:8080/pricing/?lang=fr";
const idle: ScanState = { status: "idle" };

const standard: ContentAccess = {
	status: "active",
	features: [],
	unlimited: false,
	debug: false,
	remaining: { text: 12, image: null, total: null },
};
const trial: ContentAccess = {
	status: "active",
	features: ["image_scan", "card_icons"],
	unlimited: false,
	debug: false,
	remaining: { text: null, image: null, total: 5 },
};

const result: AnalysisResult = {
	analysisId: 42,
	analyzedAt: "2026-10-17T10:00:00Z",
	fromCache: false,
	partial: false,
	professional: false,
	level: "high",
	score: 82,
	summary: { fr: "Résumé en français.", nl: "Samenvatting in het Nederlands." },
	advice: { fr: "Conseil en français.", nl: "Advies in het Nederlands." },
	reasons: [
		{
			severity: "danger",
			text: { fr: "Raison grave.", nl: "Ernstige reden." },
		},
		{
			severity: "info",
			text: { fr: "Raison info.", nl: "Informatieve reden." },
		},
	],
	remaining: { text: 11, image: null, total: null },
};

type Props = ComponentProps<typeof AiSection>;

function setup(overrides: Partial<Props> = {}) {
	const props: Props = {
		locale: "fr",
		access: standard,
		hasPhotos: true,
		text: idle,
		image: idle,
		onScan: vi.fn(),
		onLogin: vi.fn(),
		loginUnavailable: false,
		pricingUrl: PRICING,
		...overrides,
	};
	const view = render(<AiSection {...props} />);
	return { ...view, props };
}

const button = (name: string) => screen.getByRole("button", { name });
const queryButton = (name: string) => screen.queryByRole("button", { name });

describe("AiSection : accès", () => {
	test("le titre de la section est affiché", () => {
		setup();
		expect(screen.getByRole("heading", { name: "Analyse IA" })).not.toBeNull();
	});

	test("access loading : texte de chargement, aucun bouton", () => {
		setup({ access: "loading" });
		expect(screen.getByText("Chargement…")).not.toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	test("access en erreur : message de l'erreur, ou défaut si inconnu", () => {
		const { rerender, props } = setup({ access: { error: "network" } });
		expect(
			screen.getByText("Connexion impossible. Vérifiez votre réseau."),
		).not.toBeNull();
		rerender(<AiSection {...props} access={{ error: "teapot" }} />);
		expect(
			screen.getByText("Une erreur est survenue. Réessayez plus tard."),
		).not.toBeNull();
	});

	test("signedOut : bouton « Se connecter », le clic appelle onLogin", async () => {
		const user = userEvent.setup();
		const { props } = setup({ access: { status: "signedOut" } });
		expect(
			screen.getByText("Connectez-vous pour lancer une analyse IA."),
		).not.toBeNull();
		const login = button("Se connecter");
		expect(login.getAttribute("type")).toBe("button");
		await user.click(login);
		expect(props.onLogin).toHaveBeenCalledTimes(1);
		expect(queryButton("Lancer une analyse IA")).toBeNull();
		expect(
			screen.queryByText(contentText("fr", "ai.loginFallback")),
		).toBeNull();
	});

	test("loginUnavailable affiche en plus le texte de repli", () => {
		setup({ access: { status: "signedOut" }, loginUnavailable: true });
		expect(button("Se connecter")).not.toBeNull();
		expect(
			screen.getByText(
				"Cliquez sur l'icône Radarnaque dans la barre d'outils du navigateur pour vous connecter.",
			),
		).not.toBeNull();
	});

	test("noSubscription : message et lien vers les formules", () => {
		setup({ access: { status: "noSubscription" } });
		expect(
			screen.getByText(
				"Un abonnement est nécessaire pour lancer une analyse IA.",
			),
		).not.toBeNull();
		const link = screen.getByRole("link", { name: "Voir les formules" });
		expect(link.getAttribute("href")).toBe(PRICING);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener");
		expect(queryButton("Lancer une analyse IA")).toBeNull();
	});

	test("plan standard (features: []) avec photos : bouton texte seul", () => {
		setup({ access: standard, hasPhotos: true });
		expect(button("Lancer une analyse IA").getAttribute("type")).toBe("button");
		expect(queryButton("Analyse avec photos")).toBeNull();
	});

	test("essai avec photos : les deux boutons", () => {
		setup({ access: trial, hasPhotos: true });
		expect(button("Lancer une analyse IA")).not.toBeNull();
		expect(button("Analyse avec photos")).not.toBeNull();
	});

	test("essai sans photo : seul le bouton texte", () => {
		setup({ access: trial, hasPhotos: false });
		expect(button("Lancer une analyse IA")).not.toBeNull();
		expect(queryButton("Analyse avec photos")).toBeNull();
	});

	test("admin (unlimited) avec photos : les deux boutons", () => {
		setup({
			access: {
				status: "active",
				features: [],
				unlimited: true,
				debug: false,
				remaining: { text: null, image: null, total: null },
			},
		});
		expect(button("Lancer une analyse IA")).not.toBeNull();
		expect(button("Analyse avec photos")).not.toBeNull();
	});

	test("les clics appellent onScan avec le bon type", async () => {
		const user = userEvent.setup();
		const { props } = setup({ access: trial });
		await user.click(button("Lancer une analyse IA"));
		await user.click(button("Analyse avec photos"));
		expect(props.onScan).toHaveBeenNthCalledWith(1, "text");
		expect(props.onScan).toHaveBeenNthCalledWith(2, "image");
	});
});

describe("AiSection : analyse", () => {
	test("text loading : bouton désactivé avec « Analyse en cours… »", async () => {
		const user = userEvent.setup();
		const { props } = setup({ access: trial, text: { status: "loading" } });
		const running = button("Analyse en cours…");
		expect(running.hasAttribute("disabled")).toBe(true);
		expect(queryButton("Lancer une analyse IA")).toBeNull();
		await user.click(running);
		expect(props.onScan).not.toHaveBeenCalled();
		// L'autre analyse reste disponible.
		expect(button("Analyse avec photos").hasAttribute("disabled")).toBe(false);
	});

	test("done en nl : textes NL de l'IA, aucun texte FR, niveau en toutes lettres", () => {
		const { container } = setup({
			locale: "nl",
			text: { status: "done", result },
		});
		const content = container.textContent ?? "";
		expect(content).toContain("Hoog risico");
		expect(content).toContain("82/100");
		expect(content).toContain(result.summary.nl);
		expect(content).toContain(result.advice.nl);
		expect(content).toContain("Ernstige reden.");
		expect(content).toContain("Informatieve reden.");
		for (const fr of [
			result.summary.fr,
			result.advice.fr,
			"Raison grave.",
			"Raison info.",
		]) {
			expect(content).not.toContain(fr);
		}
		expect(content).toContain(contentText("nl", "ai.advice"));
		expect(content).toContain(contentText("nl", "ai.reasons"));
	});

	test("done : ordre niveau, résumé, conseil, raisons avec gravité, quota", () => {
		const { container } = setup({ text: { status: "done", result } });
		const content = container.textContent ?? "";
		const order = [
			"Risque élevé",
			"82/100",
			result.summary.fr,
			"Conseil",
			result.advice.fr,
			"Pourquoi",
			"Raison grave.",
			"Analyses restantes : 11",
		].map((part) => content.indexOf(part));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);

		const [first, second, ...rest] = screen.getAllByRole("listitem");
		expect(rest).toHaveLength(0);
		if (!first || !second) throw new Error("deux raisons attendues");
		expect(within(first).getByText("Grave")).not.toBeNull();
		expect(within(first).getByText("Raison grave.")).not.toBeNull();
		expect(within(second).getByText("Info")).not.toBeNull();
	});

	test("done : le résultat remplace le bouton d'analyse texte", () => {
		setup({ text: { status: "done", result } });
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(queryButton("Lancer une analyse IA")).toBeNull();
	});

	test("done : le texte de l'IA est rendu en texte, jamais en HTML", () => {
		const { container } = setup({
			text: {
				status: "done",
				result: {
					...result,
					summary: { fr: "<b>gras</b><img src=x>", nl: "x" },
				},
			},
		});
		expect(container.querySelector("b")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("<b>gras</b><img src=x>");
	});

	test("remaining : total prioritaire, sinon le quota du type", () => {
		const { rerender, props } = setup({
			image: {
				status: "done",
				result: { ...result, remaining: { text: 9, image: 3, total: null } },
			},
			access: trial,
		});
		expect(screen.getByText("Analyses restantes : 3")).not.toBeNull();
		rerender(
			<AiSection
				{...props}
				image={{
					status: "done",
					result: { ...result, remaining: { text: 9, image: 3, total: 7 } },
				}}
			/>,
		);
		expect(screen.getByText("Analyses restantes : 7")).not.toBeNull();
	});

	test("remaining tout à null : aucun texte « restantes »", () => {
		const { container } = setup({
			text: {
				status: "done",
				result: {
					...result,
					remaining: { text: null, image: null, total: null },
				},
			},
		});
		expect(container.textContent).not.toMatch(/restantes/);
	});

	test("remaining à 0 est affiché (quota réel épuisé)", () => {
		setup({
			text: {
				status: "done",
				result: { ...result, remaining: { text: 0, image: null, total: null } },
			},
		});
		expect(screen.getByText("Analyses restantes : 0")).not.toBeNull();
	});

	test("fromCache et partial affichent leurs mentions", () => {
		setup({
			text: {
				status: "done",
				result: { ...result, fromCache: true, partial: true },
			},
		});
		expect(
			screen.getByText("Résultat déjà disponible : servi depuis le cache."),
		).not.toBeNull();
		expect(
			screen.getByText(
				"Analyse partielle : seules les informations de la carte étaient disponibles.",
			),
		).not.toBeNull();
	});

	test("sans fromCache ni partial : aucune mention", () => {
		setup({ text: { status: "done", result } });
		expect(screen.queryByText(contentText("fr", "ai.fromCache"))).toBeNull();
		expect(screen.queryByText(contentText("fr", "ai.partial"))).toBeNull();
	});
});

describe("AiSection : erreurs", () => {
	test("quota_exhausted : message et lien vers pricingUrl", () => {
		setup({ text: { status: "error", code: "quota_exhausted" } });
		expect(
			screen.getByText(
				"Vous avez utilisé toutes vos analyses de ce type pour cette période.",
			),
		).not.toBeNull();
		const link = screen.getByRole("link", { name: "Voir les formules" });
		expect(link.getAttribute("href")).toBe(PRICING);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener");
	});

	test.each(["feature_not_in_plan", "no_active_subscription"])(
		"%s : lien vers les formules",
		(code) => {
			setup({ image: { status: "error", code }, access: trial });
			expect(
				screen.getByText(contentText("fr", `ai.error.${code}` as never)),
			).not.toBeNull();
			expect(
				screen.getByRole("link", { name: "Voir les formules" }),
			).not.toBeNull();
		},
	);

	test("analysis_failed : message, bouton actif, le clic relance", async () => {
		const user = userEvent.setup();
		const { props } = setup({
			text: { status: "error", code: "analysis_failed" },
		});
		expect(
			screen.getByText(
				"L'analyse a échoué. Elle ne vous a pas été décomptée. Réessayez plus tard.",
			),
		).not.toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		const retry = button("Lancer une analyse IA");
		expect(retry.hasAttribute("disabled")).toBe(false);
		await user.click(retry);
		expect(props.onScan).toHaveBeenCalledWith("text");
	});

	test("code inconnu : ai.error.default", () => {
		setup({ text: { status: "error", code: "teapot" } });
		expect(
			screen.getByText("Une erreur est survenue. Réessayez plus tard."),
		).not.toBeNull();
	});

	test.each(["session_expired", "unauthenticated"])(
		"%s : message puis bouton « Se connecter »",
		async (code) => {
			const user = userEvent.setup();
			const { props } = setup({
				text: { status: "error", code },
				loginUnavailable: true,
			});
			expect(
				screen.getByText("Session expirée, reconnectez-vous."),
			).not.toBeNull();
			expect(
				screen.getByText(contentText("fr", "ai.loginFallback")),
			).not.toBeNull();
			await user.click(button("Se connecter"));
			expect(props.onLogin).toHaveBeenCalledTimes(1);
		},
	);

	test("le message d'erreur est annoncé (role=alert)", () => {
		setup({ text: { status: "error", code: "rate_limited" } });
		expect(screen.getByRole("alert").textContent).toContain(
			contentText("fr", "ai.error.rate_limited"),
		);
	});

	test("erreur en nl : texte NL", () => {
		setup({ locale: "nl", text: { status: "error", code: "network" } });
		expect(
			screen.getByText(contentText("nl", "ai.error.network")),
		).not.toBeNull();
		expect(
			screen.queryByText(contentText("fr", "ai.error.network")),
		).toBeNull();
	});
});

describe("shownResult", () => {
	test("analyse terminée : son résultat", () => {
		expect(shownResult({ status: "done", result, progress: null })).toBe(
			result,
		);
	});

	test("aucune analyse terminée : null", () => {
		expect(shownResult(idle)).toBeNull();
		expect(
			shownResult({ status: "loading", progress: startProgress(0) }),
		).toBeNull();
		expect(shownResult({ status: "error", code: "network" })).toBeNull();
	});
});

describe("AiSection : résultat IA affiché", () => {
	test("résultat texte, photos possibles : seul « Analyse avec photos » reste proposé", async () => {
		const user = userEvent.setup();
		const { props } = setup({
			access: trial,
			hasPhotos: true,
			text: { status: "done", result },
		});
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(queryButton("Lancer une analyse IA")).toBeNull();
		await user.click(button("Analyse avec photos"));
		expect(props.onScan).toHaveBeenCalledWith("image");
	});

	test("résultat texte, plan sans photos : aucun bouton", () => {
		setup({ access: standard, text: { status: "done", result } });
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	test("résultat photos affiché : aucun bouton, le résultat photos seul", () => {
		const imageResult: AnalysisResult = {
			...result,
			summary: { fr: "Résumé photos.", nl: "Samenvatting foto's." },
		};
		setup({
			access: trial,
			text: { status: "done", result },
			image: { status: "done", result: imageResult },
		});
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(screen.getByText("Résumé photos.")).not.toBeNull();
		expect(screen.queryByText(result.summary.fr)).toBeNull();
	});

	test("scan photos en cours après un résultat texte : le résultat texte reste", () => {
		setup({
			access: trial,
			text: { status: "done", result },
			image: { status: "loading" },
		});
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(button("Analyse en cours…").hasAttribute("disabled")).toBe(true);
	});

	test("scan photos en erreur après un résultat texte : erreur et résultat texte", () => {
		setup({
			access: trial,
			text: { status: "done", result },
			image: { status: "error", code: "analysis_failed" },
		});
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(screen.getByRole("alert").textContent).toContain(
			contentText("fr", "ai.error.analysis_failed"),
		);
		expect(button("Analyse avec photos")).not.toBeNull();
	});

	test("résultat repris du magasin, accès pas encore chargé : le résultat s'affiche", () => {
		setup({ access: "loading", text: { status: "done", result } });
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(screen.queryByText("Chargement…")).toBeNull();
	});
});
