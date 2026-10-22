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
		const line = screen.getByText("Analyses restantes : 7");
		// Texte à lire : --text-2 (contraste sur le verre des pages tierces).
		expect(line.classList.contains("text-text-2")).toBe(true);
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
				"Vous avez utilisé toutes vos analyses IA pour cette période.",
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

describe("AiSection : design du panneau", () => {
	/** Classes d'un élément, pour des assertions lisibles. */
	const classesOf = (el: Element | null | undefined) =>
		new Set((el?.getAttribute("class") ?? "").split(/\s+/));
	const WHITE_PILL = ["bg-white", "text-text-on-light", "rounded-pill"];
	const expectWhitePill = (el: Element) => {
		for (const name of WHITE_PILL)
			expect(classesOf(el).has(name), name).toBe(true);
		expect(el.getAttribute("class")).toContain("shadow-[var(--shadow-pill)]");
	};

	test("le titre « Analyse IA » est réservé aux lecteurs d'écran (sr-only)", () => {
		setup();
		const heading = screen.getByRole("heading", { name: "Analyse IA" });
		expect(classesOf(heading).has("sr-only")).toBe(true);
	});

	test("résultat high 82 : « 82 » et « /100 » dans le bloc du score, badge « Risque élevé », barre à 82 %", () => {
		const { container } = setup({ ai: done() });
		const score = screen.getByText("82");
		for (const name of ["font-serif", "text-[44px]", "tabular-nums"])
			expect(classesOf(score).has(name), name).toBe(true);
		const outOf = score.nextElementSibling;
		expect(outOf?.textContent).toBe("/100");
		expect(classesOf(outOf).has("text-text-2")).toBe(true);

		const verdict = screen.getByText("Risque élevé").closest("[data-verdict]");
		if (!verdict) throw new Error("badge de verdict attendu");
		expect(classesOf(verdict).has("bg-danger-soft")).toBe(true);
		expect(classesOf(verdict).has("text-danger")).toBe(true);
		const dot = verdict.querySelector("[aria-hidden='true']");
		expect(classesOf(dot).has("bg-danger")).toBe(true);
		expect(classesOf(dot).has("rounded-full")).toBe(true);
		// Lu avant le score (comme la pilule), affiché à droite du nombre.
		expect(
			verdict.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(classesOf(verdict.parentElement).has("flex-row-reverse")).toBe(true);

		const bar = container.querySelector("[role='presentation']");
		if (!bar) throw new Error("barre du score attendue");
		expect(classesOf(bar).has("h-1")).toBe(true);
		const fill = bar.firstElementChild as HTMLElement | null;
		expect(fill?.style.width).toBe("82%");
		expect(classesOf(fill).has("bg-danger")).toBe(true);
	});

	test("niveaux faible et moyen : badge et barre prennent LEVEL_STYLE", () => {
		const { container, rerender, props } = setup({
			ai: done({ ...result, level: "low", score: 12 }),
		});
		const verdictOf = (text: string) =>
			screen.getByText(text).closest("[data-verdict]");
		expect(classesOf(verdictOf("Risque faible")).has("bg-success-soft")).toBe(
			true,
		);
		const fill = () =>
			container.querySelector("[role='presentation']")
				?.firstElementChild as HTMLElement | null;
		expect(fill()?.style.width).toBe("12%");
		expect(classesOf(fill()).has("bg-success")).toBe(true);
		rerender(
			<AiSection
				{...props}
				ai={done({ ...result, level: "medium", score: 55 })}
			/>,
		);
		expect(classesOf(verdictOf("Risque moyen")).has("text-warning")).toBe(true);
		expect(classesOf(fill()).has("bg-warning")).toBe(true);
	});

	test("« Conseil » et « Pourquoi » en style label ; résumé en text-text-1", () => {
		setup({ ai: done() });
		for (const label of ["Conseil", "Pourquoi"]) {
			const el = screen.getByText(label);
			for (const name of ["uppercase", "text-[11px]", "tracking-[0.06em]"])
				expect(classesOf(el).has(name), `${label} ${name}`).toBe(true);
		}
		expect(
			classesOf(screen.getByText(result.summary.fr)).has("text-text-1"),
		).toBe(true);
	});

	test("raisons : chaque badge de gravité garde son texte et prend SEVERITY_STYLE", () => {
		setup({
			ai: done({
				...result,
				reasons: [
					{ severity: "danger", text: { fr: "Grave.", nl: "x" } },
					{ severity: "warning", text: { fr: "Attention.", nl: "x" } },
					{ severity: "info", text: { fr: "Info.", nl: "x" } },
				],
			}),
		});
		const items = screen.getAllByRole("listitem");
		const expected = [
			["Grave", "bg-danger-soft", "text-danger"],
			["Attention", "bg-warning-soft", "text-warning"],
			// Texte clair sur le fond bleu doux : `text-info` y tombe à 4,3:1 (galerie).
			["Info", "bg-info-soft", "text-text-1"],
		] as const;
		expect(items).toHaveLength(expected.length);
		expected.forEach(([text, soft, color], index) => {
			const item = items[index];
			if (!item) throw new Error("raison attendue");
			const badge = within(item).getByText(text);
			expect(classesOf(badge).has(soft), soft).toBe(true);
			expect(classesOf(badge).has(color), color).toBe(true);
			expect(classesOf(badge).has("rounded-pill")).toBe(true);
		});
	});

	test("pied : séparateur border-subtle, analyses restantes à gauche, déroulé replié à droite", () => {
		const progress = addEvent(
			startProgress(0),
			{ type: "stage", stage: "writing" },
			2_000,
		);
		const { container } = setup({ ai: { status: "done", result, progress } });
		const footer = container.querySelector("footer");
		if (!footer) throw new Error("pied attendu");
		expect(classesOf(footer).has("border-t")).toBe(true);
		expect(classesOf(footer).has("border-border-subtle")).toBe(true);
		const remaining = within(footer).getByText("Analyses restantes : 11");
		const details = footer.querySelector("details");
		if (!details) throw new Error("déroulé attendu dans le pied");
		// Même rangée : les analyses restantes puis le déroulé, poussé à droite.
		expect(remaining.parentElement).toBe(details.parentElement);
		expect(remaining.nextElementSibling).toBe(details);
		expect(classesOf(details).has("ml-auto")).toBe(true);
	});

	test("mentions cache, partiel, sans photo : dans le pied, en 12 px text-text-2 (contraste)", () => {
		const { container } = setup({
			ai: done({
				...result,
				fromCache: true,
				partial: true,
				imagesAnalyzed: 0,
			}),
		});
		const footer = container.querySelector("footer");
		for (const key of ["ai.fromCache", "ai.partial", "ai.noPhoto"] as const) {
			const el = screen.getByText(contentText("fr", key));
			expect(footer?.contains(el), key).toBe(true);
			expect(classesOf(el).has("text-text-2"), key).toBe(true);
			expect(classesOf(el).has("text-[12px]"), key).toBe(true);
		}
	});

	test("illimité, sans déroulé ni mention : aucun pied vide", () => {
		const { container } = setup({
			ai: done({ ...result, remaining: { scans: null } }),
		});
		expect(container.querySelector("footer")).toBeNull();
	});

	test("déconnecté : phrase ai.loginHint en titre serif, bouton « Se connecter » en pilule blanche", () => {
		setup({ access: { status: "signedOut" } });
		const hint = screen.getByText(contentText("fr", "ai.loginHint"));
		for (const name of ["font-serif", "text-[22px]", "text-text-1"])
			expect(classesOf(hint).has(name), name).toBe(true);
		const login = button("Se connecter");
		expectWhitePill(login);
		// La phrase, puis l'action.
		expect(
			hint.compareDocumentPosition(login) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	test("sans abonnement : message en titre serif, lien vers les formules en pilule blanche", () => {
		setup({ access: { status: "noSubscription" } });
		const message = screen.getByRole("alert");
		expect(classesOf(message).has("font-serif")).toBe(true);
		expect(classesOf(message).has("text-[22px]")).toBe(true);
		expectWhitePill(screen.getByRole("link", { name: "Voir les formules" }));
	});

	test("analyse interrompue : message en titre serif, puis « Relancer » en pilule blanche", () => {
		setup({ ai: { status: "error", code: "timeout" } });
		const message = screen.getByRole("alert");
		expect(classesOf(message).has("font-serif")).toBe(true);
		const retry = button("Relancer");
		expectWhitePill(retry);
		expect(
			message.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	test("accès actif au repos : « Lancer une analyse IA » en pilule blanche", () => {
		setup();
		expectWhitePill(button("Lancer une analyse IA"));
	});

	/** Pilule secondaire (DESIGN.md §3) : transparente, bordure --border-strong, texte --text-1. */
	const expectSecondaryPill = (el: Element) => {
		for (const name of [
			"bg-transparent",
			"border",
			"border-border-strong",
			"text-text-1",
			"rounded-pill",
		])
			expect(classesOf(el).has(name), name).toBe(true);
		expect(classesOf(el).has("bg-white")).toBe(false);
	};

	test.each([
		["feature_not_in_plan", "link", "Voir les formules"],
		["quota_exhausted", "link", "Voir les formules"],
		["session_expired", "button", "Se connecter"],
	] as const)(
		"erreur %s avec sa propre action : une seule pilule blanche, « Lancer une analyse IA » en secondaire",
		(code, role, name) => {
			setup({ ai: { status: "error", code } });
			expectWhitePill(screen.getByRole(role, { name }));
			expectSecondaryPill(button("Lancer une analyse IA"));
		},
	);

	test("erreur sans action propre : « Lancer une analyse IA » reste la pilule blanche", () => {
		setup({ ai: { status: "error", code: "analysis_failed" } });
		expectWhitePill(button("Lancer une analyse IA"));
	});

	test("survol des pilules : pas de déplacement si l'utilisateur réduit les animations", () => {
		setup({ ai: { status: "error", code: "session_expired" } });
		expect(button("Se connecter").className).toContain(
			"motion-reduce:hover:translate-y-0",
		);
		// La pilule secondaire ne se soulève jamais.
		expect(button("Lancer une analyse IA").className).not.toContain(
			"translate",
		);
	});

	test("plus aucune couleur Tailwind brute (slate, red) dans la section", () => {
		for (const ai of [
			idle,
			done(),
			loading,
			{ status: "error", code: "session_expired" } as ScanState,
		]) {
			const { container, unmount } = setup({ ai, loginUnavailable: true });
			expect(container.innerHTML).not.toMatch(
				/\bslate-|\bred-\d|\btext-white\b/,
			);
			unmount();
		}
	});
});
