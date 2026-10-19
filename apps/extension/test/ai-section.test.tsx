import type { AnalysisResult } from "@radarnaque/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AiSection } from "../components/AiSection";
import type { ScanState } from "../lib/content/ai-client";
import { addEvent, startProgress } from "../lib/content/scan-progress";
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
	maxImages: 1,
	remaining: { scans: 12 },
};
const trial: ContentAccess = {
	status: "active",
	features: ["card_icons"],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 5 },
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
	remaining: { scans: 11 },
	imagesAnalyzed: 3,
	webSearches: [],
};

/** Analyse terminée, sans déroulé (reprise du magasin) sauf `progress` donné. */
const done = (r: AnalysisResult = result): ScanState => ({
	status: "done",
	result: r,
	progress: null,
});
const loading: ScanState = { status: "loading", progress: startProgress(0) };

type Props = ComponentProps<typeof AiSection>;

function setup(overrides: Partial<Props> = {}) {
	const props: Props = {
		locale: "fr",
		access: standard,
		ai: idle,
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

	test("no photo-scan button : une seule action, quel que soit le plan", async () => {
		const user = userEvent.setup();
		for (const access of [
			standard,
			trial,
			{ ...standard, unlimited: true, remaining: { scans: null } },
		]) {
			const { props, unmount } = setup({ access });
			expect(button("Lancer une analyse IA").getAttribute("type")).toBe(
				"button",
			);
			expect(screen.getAllByRole("button")).toHaveLength(1);
			expect(screen.queryByText(/photos/)).toBeNull();
			await user.click(button("Lancer une analyse IA"));
			expect(props.onScan).toHaveBeenCalledTimes(1);
			unmount();
		}
	});
});

describe("AiSection : analyse", () => {
	test("loading : bouton désactivé avec « Analyse en cours… », et le déroulé en direct", async () => {
		const user = userEvent.setup();
		const progress = addEvent(
			startProgress(0),
			{ type: "search", id: 1, query: "iPhone 18 Pro prix", aspect: "price" },
			3_000,
		);
		const { props, container } = setup({
			access: trial,
			ai: { status: "loading", progress },
		});
		const running = button("Analyse en cours…");
		expect(running.hasAttribute("disabled")).toBe(true);
		expect(queryButton("Lancer une analyse IA")).toBeNull();
		await user.click(running);
		expect(props.onScan).not.toHaveBeenCalled();
		// Déroulé en direct : déplié, sans « Comment l'IA a analysé ».
		expect(container.querySelector("details")).toBeNull();
		expect(screen.getByRole("listitem").textContent).toContain(
			"Recherche web (prix du marché) : “iPhone 18 Pro prix”",
		);
	});

	test("done en nl : textes NL de l'IA, aucun texte FR, niveau en toutes lettres", () => {
		const { container } = setup({
			locale: "nl",
			ai: done(),
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
		const { container } = setup({ ai: done() });
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
		setup({ ai: done() });
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(queryButton("Lancer une analyse IA")).toBeNull();
	});

	test("done : le texte de l'IA est rendu en texte, jamais en HTML", () => {
		const { container } = setup({
			ai: done({
				...result,
				summary: { fr: "<b>gras</b><img src=x>", nl: "x" },
			}),
		});
		expect(container.querySelector("b")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("<b>gras</b><img src=x>");
	});

	test("remaining : les analyses restantes du résultat", () => {
		setup({ ai: done({ ...result, remaining: { scans: 7 } }) });
		expect(screen.getByText("Analyses restantes : 7")).not.toBeNull();
	});

	test("remaining à null : aucun texte « restantes »", () => {
		const { container } = setup({
			ai: done({ ...result, remaining: { scans: null } }),
		});
		expect(container.textContent).not.toMatch(/restantes/);
	});

	test("remaining à 0 est affiché (quota réel épuisé)", () => {
		setup({ ai: done({ ...result, remaining: { scans: 0 } }) });
		expect(screen.getByText("Analyses restantes : 0")).not.toBeNull();
	});

	test("no photo mention : imagesAnalyzed 0 donne « Analysée sans photo »", () => {
		const { rerender, props } = setup({
			ai: done({ ...result, imagesAnalyzed: 0 }),
		});
		expect(screen.getByText("Analysée sans photo")).not.toBeNull();
		rerender(<AiSection {...props} locale="nl" />);
		expect(screen.getByText("Geanalyseerd zonder foto")).not.toBeNull();
		rerender(<AiSection {...props} ai={done()} />);
		expect(screen.queryByText("Analysée sans photo")).toBeNull();
	});

	test("web searches listed for cached result : sous « Comment l'IA a analysé »", () => {
		const { container } = setup({
			ai: done({
				...result,
				fromCache: true,
				webSearches: [{ query: "iPhone 18 Pro prix", aspect: "price" }],
			}),
		});
		const details = container.querySelector("details");
		expect(details?.querySelector("summary")?.textContent).toBe(
			"Comment l'IA a analysé",
		);
		expect(details?.textContent).toContain(
			"Recherche web (prix du marché) : “iPhone 18 Pro prix”",
		);
	});

	test("done avec son déroulé : replié sous « Comment l'IA a analysé », après le verdict", () => {
		const progress = addEvent(
			startProgress(0),
			{ type: "stage", stage: "writing" },
			2_000,
		);
		const { container } = setup({
			ai: { status: "done", result, progress },
		});
		const details = container.querySelector("details");
		expect(details?.textContent).toContain("Rédige le verdict");
		const content = container.textContent ?? "";
		expect(content.indexOf(result.summary.fr)).toBeLessThan(
			content.indexOf("Comment l'IA a analysé"),
		);
	});

	test("done sans déroulé ni recherche : pas de « Comment l'IA a analysé »", () => {
		setup({ ai: done() });
		expect(screen.queryByText("Comment l'IA a analysé")).toBeNull();
	});

	test("fromCache et partial affichent leurs mentions", () => {
		setup({
			ai: done({ ...result, fromCache: true, partial: true }),
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
		setup({ ai: done() });
		expect(screen.queryByText(contentText("fr", "ai.fromCache"))).toBeNull();
		expect(screen.queryByText(contentText("fr", "ai.partial"))).toBeNull();
	});
});

describe("AiSection : erreurs", () => {
	test("quota_exhausted : message et lien vers pricingUrl", () => {
		setup({ ai: { status: "error", code: "quota_exhausted" } });
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
			setup({ ai: { status: "error", code }, access: trial });
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
			ai: { status: "error", code: "analysis_failed" },
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
		expect(props.onScan).toHaveBeenCalledTimes(1);
	});

	test.each(["stream_interrupted", "timeout"])(
		"%s : message et bouton « Relancer »",
		async (code) => {
			const user = userEvent.setup();
			const { props } = setup({ ai: { status: "error", code } });
			expect(screen.getByRole("alert").textContent).toBe(
				contentText("fr", `ai.error.${code}` as never),
			);
			expect(queryButton("Lancer une analyse IA")).toBeNull();
			await user.click(button("Relancer"));
			expect(props.onScan).toHaveBeenCalledTimes(1);
		},
	);

	test("code inconnu : ai.error.default", () => {
		setup({ ai: { status: "error", code: "teapot" } });
		expect(
			screen.getByText("Une erreur est survenue. Réessayez plus tard."),
		).not.toBeNull();
	});

	test.each(["session_expired", "unauthenticated"])(
		"%s : message puis bouton « Se connecter »",
		async (code) => {
			const user = userEvent.setup();
			const { props } = setup({
				ai: { status: "error", code },
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
		setup({ ai: { status: "error", code: "rate_limited" } });
		expect(screen.getByRole("alert").textContent).toContain(
			contentText("fr", "ai.error.rate_limited"),
		);
	});

	test("erreur en nl : texte NL", () => {
		setup({ locale: "nl", ai: { status: "error", code: "network" } });
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
		expect(shownResult(loading)).toBeNull();
		expect(shownResult({ status: "error", code: "network" })).toBeNull();
	});
});

describe("AiSection : résultat IA affiché", () => {
	test("résultat affiché : aucun bouton, ni analyse ni photos", () => {
		setup({ access: trial, ai: done() });
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	test("résultat repris du magasin, accès pas encore chargé : le résultat s'affiche", () => {
		setup({ access: "loading", ai: done() });
		expect(screen.getByText(result.summary.fr)).not.toBeNull();
		expect(screen.queryByText("Chargement…")).toBeNull();
	});
});
