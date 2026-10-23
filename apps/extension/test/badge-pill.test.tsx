import type {
	AnalysisResult,
	IdentificationResult,
	Locale,
	ScanProgressEvent,
} from "@radarnaque/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BadgePill } from "../components/BadgePill";
import type { IdentifyState, ScanState } from "../lib/content/ai-client";
import {
	addEvent,
	type ScanProgress,
	startProgress,
} from "../lib/content/scan-progress";
import type { AiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { ContentAccess } from "../lib/messages";
import { sampleAnalysis, sampleIdentification } from "./helpers";

afterEach(cleanup);

const active: ContentAccess = {
	status: "active",
	features: [],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
};
const empty: ContentAccess = { ...active, remaining: { scans: 0 } };
const noSubscription = { status: "noSubscription" } as ContentAccess;
const PRICING = "http://localhost:8080/pricing/?lang=fr";

/** `AiScan` simulé : accès actif, rien en cours ; chaque test règle le reste. */
function scanWith(overrides: Partial<AiScan> = {}): AiScan {
	return {
		access: active,
		ai: { status: "idle" },
		identification: { status: "idle" },
		identify: vi.fn(),
		analysisIncluded: false,
		loginUnavailable: false,
		pricingUrl: PRICING,
		loadAccess: vi.fn(),
		scan: vi.fn(),
		rescan: vi.fn(),
		rescanning: false,
		rescanError: null,
		restoring: false,
		login: vi.fn(),
		...overrides,
	};
}

/** Props de la pilule, hors `scan` : les rappels sont des espions. */
const handlers = () => ({
	onToggle: vi.fn(),
	onIdentify: vi.fn(),
	onAnalyze: vi.fn(),
});

function renderPill({
	locale = "fr",
	open = false,
	...overrides
}: Partial<AiScan> & { locale?: Locale; open?: boolean } = {}) {
	const spies = handlers();
	const scan = scanWith(overrides);
	const view = render(
		<BadgePill scan={scan} locale={locale} open={open} {...spies} />,
	);
	return { ...view, scan, ...spies };
}

const progressOf = (...events: ScanProgressEvent[]): ScanProgress =>
	events.reduce(
		(p, e, i) => addEvent(p, e, 1_000 + i),
		startProgress(Date.now()),
	);

const done = (result: IdentificationResult): IdentifyState => ({
	status: "done",
	result,
	progress: null,
});
const identifyLoading = (...events: ScanProgressEvent[]): IdentifyState => ({
	status: "loading",
	progress: progressOf(...events),
});
const riskLoading = (...events: ScanProgressEvent[]): ScanState => ({
	status: "loading",
	progress: progressOf(...events),
});
const riskDone = (result: AnalysisResult = sampleAnalysis): ScanState => ({
	status: "done",
	result,
	progress: null,
});

/** Résultat incertain : deux candidats restent, pas de référence. */
const uncertain: IdentificationResult = {
	...sampleIdentification,
	status: "uncertain",
	confidence: 55,
	level: "uncertain",
	objects: [
		{
			...(sampleIdentification
				.objects[0] as IdentificationResult["objects"][number]),
			reference: null,
			confidence: 55,
			level: "uncertain",
			remaining: ["Steam Deck OLED", "Steam Deck LCD", "ROG Ally"],
		},
	],
};
const probable: IdentificationResult = {
	...sampleIdentification,
	confidence: 80,
	level: "probable",
	objects: [
		{
			...(sampleIdentification
				.objects[0] as IdentificationResult["objects"][number]),
			confidence: 80,
			level: "probable",
		},
	],
};
const none: IdentificationResult = {
	...sampleIdentification,
	status: "none",
	confidence: 0,
	level: "uncertain",
	objects: [],
};

const SURE_NAME = "Identification : Steam Deck OLED · Sûr";
/** Le bouton de la pilule quand elle n'en a qu'un (repos, en cours, résultat). */
const pillButton = () => screen.getByRole("button");
/** La partie produit de la pilule « Produit identifié ». */
const productButton = () => screen.getByRole("button", { name: /^Identifica/ });
const analyzeRisk = (locale: Locale = "fr") =>
	screen.getByRole("button", { name: contentText(locale, "ai.analyzeRisk") });
const lineText = () =>
	document.querySelector(".radarnaque-status .rq-shimmer")?.textContent;
const describedTexts = (element: Element) =>
	(element.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.filter(Boolean)
		.map((id) => document.getElementById(id)?.textContent);
/** Aucune couleur sémantique du risque dans la pilule. */
const SEMANTIC =
	/(^|\s)(text|bg|border)-(danger|warning|success|info)(-soft)?(\s|$)/;

describe("BadgePill : repos", () => {
	test.each([
		["fr", "Identifier", "Identifier le produit"],
		["nl", "Identificeren", "Product identificeren"],
	] as const)(
		"%s : logo et « %s », nom accessible « %s », le clic identifie",
		(locale, text, name) => {
			const { onIdentify, onAnalyze, onToggle } = renderPill({ locale });
			const pill = screen.getByRole("button", { name });
			expect(pill.textContent).toBe(text);
			expect(pill.getAttribute("type")).toBe("button");
			expect(pill.hasAttribute("aria-expanded")).toBe(false);
			const logo = pill.querySelector("svg");
			expect(logo?.getAttribute("width")).toBe("16");
			expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
			// Surface de la pilule : 28 px, verre sombre, anneau de focus.
			for (const name of [
				"h-7",
				"rounded-pill",
				"bg-glass-host",
				"text-[13px]",
				"font-medium",
				"focus-visible:shadow-[var(--focus-ring)]",
			])
				expect(pill.classList.contains(name), name).toBe(true);
			pill.click();
			expect(onIdentify).toHaveBeenCalledTimes(1);
			expect(onAnalyze).not.toHaveBeenCalled();
			expect(onToggle).not.toHaveBeenCalled();
			// Une seule pilule, une seule région annoncée.
			expect(screen.getAllByRole("button")).toHaveLength(1);
			expect(screen.getAllByRole("status")).toHaveLength(1);
		},
	);

	test("lecture du magasin en cours : rien à cliquer", () => {
		const { container } = renderPill({
			restoring: true,
			identification: done(sampleIdentification),
		});
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(container.querySelector("svg")).toBeNull();
	});

	test("déconnecté : la pilule de repos, le clic passe par onIdentify (connexion)", () => {
		const { onIdentify } = renderPill({
			access: { status: "signedOut" } as ContentAccess,
		});
		screen.getByRole("button", { name: "Identifier le produit" }).click();
		expect(onIdentify).toHaveBeenCalledTimes(1);
	});

	test.each(["fr", "nl"] as const)(
		"%s : sans abonnement, un lien vers les formules nommé comme la pilule",
		(locale) => {
			renderPill({ locale, access: noSubscription });
			const link = screen.getByRole("link", {
				name: contentText(locale, "identify.launch"),
			});
			expect(link.getAttribute("href")).toBe(PRICING);
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.textContent).toBe(
				contentText(locale, "identify.launchShort"),
			);
		},
	);

	test.each(["fr", "nl"] as const)(
		"%s : quota épuisé, grisée mais focusable, décrite par la raison",
		(locale) => {
			const { onIdentify } = renderPill({ locale, access: empty });
			const pill = screen.getByRole("button", {
				name: contentText(locale, "identify.launch"),
			});
			expect(pill.getAttribute("aria-disabled")).toBe("true");
			expect(describedTexts(pill)).toEqual([
				contentText(locale, "ai.noScansLeft"),
			]);
			pill.click();
			// Le clic arrive à onIdentify, qui ne fait rien sans analyse restante.
			expect(onIdentify).toHaveBeenCalledTimes(1);
		},
	);
});

describe("BadgePill : identification en cours", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		["fr", "Lecture des photos…"],
		["nl", "Foto's lezen…"],
	] as const)("%s : logo animé, ligne d'état « %s »", (locale, line) => {
		// Texte visible sans « … » final : les points fixes de la ligne le donnent.
		const visible = line.replace(/…$/, "");
		const { onToggle } = renderPill({
			locale,
			identification: identifyLoading({
				type: "stage",
				stage: "reading_photos",
			}),
		});
		const pill = pillButton();
		expect(pill.getAttribute("aria-busy")).toBe("true");
		expect(pill.getAttribute("aria-expanded")).toBe("false");
		expect(pill.getAttribute("aria-label")).toBe(
			contentText(locale, "badge.aria"),
		);
		expect(
			pill.querySelector("svg")?.classList.contains("rq-logo--loading"),
		).toBe(true);
		expect(lineText()).toBe(visible);
		// La région annoncée garde le texte entier.
		expect(screen.getByRole("status").textContent).toBe(line);
		pill.click();
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	test("avant le premier événement : « Démarrage de l'identification… »", () => {
		renderPill({ identification: identifyLoading() });
		expect(lineText()).toBe("Démarrage de l'identification");
		expect(screen.getByRole("status").textContent).toBe(
			"Démarrage de l'identification…",
		);
	});

	test("ligne d'état : page lue, critères connus ; points de suspension après 4 s", () => {
		vi.useFakeTimers();
		renderPill({
			identification: identifyLoading(
				{ type: "criteria_cached", count: 4 },
				{ type: "page_read", domain: "www.steamdeck.com", ok: true },
			),
		});
		const status = document.querySelector(".radarnaque-status");
		expect(status?.textContent).toBe("Lecture : www.steamdeck.com");
		expect(status?.classList.contains("is-waiting")).toBe(false);
		act(() => vi.advanceTimersByTime(4_000));
		expect(
			document
				.querySelector(".radarnaque-status")
				?.classList.contains("is-waiting"),
		).toBe(true);
	});

	test("aria-live au plus toutes les 2 s", () => {
		vi.useFakeTimers();
		const scan = scanWith();
		const props = { locale: "fr" as const, open: false, ...handlers() };
		const { rerender } = render(<BadgePill scan={scan} {...props} />);
		const region = screen.getByRole("status");
		expect(region.getAttribute("aria-live")).toBe("polite");
		expect(region.textContent).toBe("");
		const at = (progress: ScanProgress) => (
			<BadgePill
				scan={{ ...scan, identification: { status: "loading", progress } }}
				{...props}
			/>
		);
		const first = progressOf({ type: "stage", stage: "reading_photos" });
		// Première annonce aussitôt.
		rerender(at(first));
		expect(region.textContent).toBe("Lecture des photos…");
		rerender(
			at(addEvent(first, { type: "stage", stage: "identifying" }, 2_000)),
		);
		// La ligne visible suit ; la région annoncée attend la fin des 2 s.
		expect(lineText()).toBe("Vérification des critères");
		expect(region.textContent).toBe("Lecture des photos…");
		act(() => vi.advanceTimersByTime(1_999));
		expect(region.textContent).toBe("Lecture des photos…");
		act(() => vi.advanceTimersByTime(1));
		expect(region.textContent).toBe("Vérification des critères…");
	});
});

describe("BadgePill : produit identifié", () => {
	test.each([
		["fr", SURE_NAME, "Sûr", "Analyser le risque"],
		[
			"nl",
			"Identificatie: Steam Deck OLED · Zeker",
			"Zeker",
			"Risico analyseren",
		],
	] as const)(
		"%s : glyphe ●, référence, niveau sans pourcentage, séparateur, « %s »",
		(locale, name, level, action) => {
			const { onToggle, onAnalyze, onIdentify } = renderPill({
				locale,
				identification: done(sampleIdentification),
			});
			const product = screen.getByRole("button", { name });
			expect(product.getAttribute("type")).toBe("button");
			expect(product.getAttribute("aria-expanded")).toBe("false");
			expect(product.querySelector("[data-reference]")?.textContent).toBe(
				"Steam Deck OLED",
			);
			expect(product.querySelector("[data-level]")?.textContent).toBe(level);
			const glyph = product.querySelector("[data-glyph]");
			expect(glyph?.textContent).toBe("●");
			expect(glyph?.getAttribute("aria-hidden")).toBe("true");
			// Le pourcentage reste dans le panneau.
			expect(product.querySelector("[data-percent]")).toBeNull();
			expect(product.textContent).not.toMatch(/\d/);
			// Ni logo, ni animation : le produit seul.
			expect(product.querySelector("svg")).toBeNull();

			const button = analyzeRisk(locale);
			expect(button.textContent).toBe(action);
			expect(button.getAttribute("type")).toBe("button");
			expect(button.classList.contains("underline")).toBe(true);
			expect(button.hasAttribute("aria-disabled")).toBe(false);
			// Produit, séparateur, action : dans la même pilule de verre sombre.
			const pill = product.parentElement as HTMLElement;
			expect(button.parentElement).toBe(pill);
			expect(pill.classList.contains("bg-glass-host")).toBe(true);
			expect(pill.classList.contains("h-7")).toBe(true);
			// Cet état seul va jusqu'à 400 px, pour garder la référence lisible.
			expect(pill.classList.contains("max-w-[400px]")).toBe(true);
			expect(pill.classList.contains("max-w-[340px]")).toBe(false);
			const separator = product.nextElementSibling;
			expect(separator?.getAttribute("aria-hidden")).toBe("true");
			expect(separator?.nextElementSibling).toBe(button);

			product.click();
			expect(onToggle).toHaveBeenCalledTimes(1);
			expect(onAnalyze).not.toHaveBeenCalled();
			button.click();
			expect(onAnalyze).toHaveBeenCalledTimes(1);
			expect(onIdentify).not.toHaveBeenCalled();
			// Rien à annoncer : ce n'est pas une ligne d'état.
			expect(screen.getByRole("status").textContent).toBe("");
		},
	);

	test.each([
		["bouton", active],
		["lien", noSubscription],
	] as const)(
		"cibles de clic (%s) : la partie produit et l'action remplissent la hauteur de la pilule et son padding",
		(_, access) => {
			renderPill({ access, identification: done(sampleIdentification) });
			const product = productButton();
			const action =
				screen.queryByRole("button", { name: "Analyser le risque" }) ??
				screen.getByRole("link", { name: "Analyser le risque" });
			const pill = product.parentElement as HTMLElement;
			// 28 px de pilule, bordure comprise : chaque cible fait 26 px de haut.
			expect(pill.classList.contains("h-7")).toBe(true);
			expect(pill.classList.contains("px-3")).toBe(true);
			for (const target of [product, action]) {
				expect(target.classList.contains("self-stretch")).toBe(true);
				expect(target.classList.contains("inline-flex")).toBe(true);
				expect(target.classList.contains("items-center")).toBe(true);
			}
			// Le padding de la pilule appartient aux cibles, pas au vide.
			for (const name of ["-ml-3", "pl-3", "rounded-l-pill"])
				expect(product.classList.contains(name), name).toBe(true);
			for (const name of ["-mr-3", "pr-3", "rounded-r-pill"])
				expect(action.classList.contains(name), name).toBe(true);
		},
	);

	test("panneau ouvert : aria-expanded vrai sur la partie produit", () => {
		renderPill({ open: true, identification: done(sampleIdentification) });
		expect(productButton().getAttribute("aria-expanded")).toBe("true");
	});

	test("probable : glyphe ◐", () => {
		renderPill({ identification: done(probable) });
		const product = productButton();
		expect(product.querySelector("[data-glyph]")?.textContent).toBe("◐");
		expect(product.getAttribute("aria-label")).toBe(
			"Identification : Steam Deck OLED · Probable",
		);
	});

	test.each([
		[
			"fr",
			"Identification : ",
			"Steam Deck OLED ou Steam Deck LCD ? · Incertain",
		],
		["nl", "Identificatie: ", "Steam Deck OLED of Steam Deck LCD? · Onzeker"],
	] as const)(
		"%s : incertain, deux candidats, glyphe ○ et l'action",
		(locale, prefix, text) => {
			renderPill({ locale, identification: done(uncertain) });
			const product = screen.getByRole("button", { name: `${prefix}${text}` });
			expect(product.querySelector("[data-glyph]")?.textContent).toBe("○");
			expect(product.querySelector("[data-reference]")?.textContent).toBe(
				text.split(" · ")[0],
			);
			expect(product.querySelector("[data-level]")?.textContent).toBe(
				text.split(" · ")[1],
			);
			expect(analyzeRisk(locale)).toBeTruthy();
		},
	);

	test.each([
		["fr", "Identification : ", "Produit non identifié"],
		["nl", "Identificatie: ", "Product niet geïdentificeerd"],
	] as const)(
		"%s : rien d'identifiable, « %s%s », puis l'action",
		(locale, prefix, text) => {
			renderPill({ locale, identification: done(none) });
			const product = screen.getByRole("button", { name: `${prefix}${text}` });
			expect(product.textContent).toBe(text);
			expect(product.querySelector("[data-percent]")).toBeNull();
			expect(analyzeRisk(locale)).toBeTruthy();
		},
	);

	test("référence de plus de 32 caractères : tronquée avec « … », nom accessible complet", () => {
		const reference = "Apple MacBook Pro 14-pouces-M4-Max-2026-1To";
		renderPill({
			identification: done({
				...sampleIdentification,
				objects: [
					{
						...(sampleIdentification
							.objects[0] as IdentificationResult["objects"][number]),
						reference,
					},
				],
			}),
		});
		const product = productButton();
		const shown = product.querySelector("[data-reference]")?.textContent ?? "";
		expect(Array.from(shown)).toHaveLength(32);
		expect(shown).toBe(`${reference.slice(0, 31).trimEnd()}…`);
		expect(product.getAttribute("aria-label")).toBe(
			`Identification : ${reference} · Sûr`,
		);
	});

	test("incertain, candidats longs : chacun tronqué à 32, nom accessible complet", () => {
		const a = "Apple MacBook Pro 14 pouces M4 Max 2026";
		const b = "Apple MacBook Pro 16 pouces M4 Max 2026";
		renderPill({
			identification: done({
				...uncertain,
				objects: [
					{
						...(uncertain
							.objects[0] as IdentificationResult["objects"][number]),
						remaining: [a, b],
					},
				],
			}),
		});
		const product = productButton();
		const cut = (s: string) => `${s.slice(0, 31).trimEnd()}…`;
		expect(product.querySelector("[data-reference]")?.textContent).toBe(
			`${cut(a)} ou ${cut(b)} ?`,
		);
		expect(product.getAttribute("aria-label")).toBe(
			`Identification : ${a} ou ${b} ? · Incertain`,
		);
	});

	test.each([
		["sûr", sampleIdentification],
		["probable", probable],
		["incertain", uncertain],
		["non identifié", none],
	])("%s : aucune couleur sémantique du risque", (_, result) => {
		const { container } = renderPill({ identification: done(result) });
		for (const element of Array.from(container.querySelectorAll("*")))
			expect(element.getAttribute("class") ?? "").not.toMatch(SEMANTIC);
	});

	test.each([
		["fr", "Inclus avec l'identification"],
		["nl", "Inbegrepen bij de identificatie"],
	] as const)(
		"%s : incluse, l'action est décrite par « %s », même à 0 analyse restante",
		(locale, text) => {
			const { onAnalyze } = renderPill({
				locale,
				access: empty,
				analysisIncluded: true,
				identification: done(sampleIdentification),
			});
			const button = analyzeRisk(locale);
			expect(describedTexts(button)).toEqual([text]);
			expect(button.hasAttribute("aria-disabled")).toBe(false);
			button.click();
			expect(onAnalyze).toHaveBeenCalledTimes(1);
		},
	);

	test.each(["fr", "nl"] as const)(
		"%s : 0 analyse restante sans inclusion, l'action est grisée, décrite par la raison",
		(locale) => {
			const { onAnalyze } = renderPill({
				locale,
				access: empty,
				identification: done(sampleIdentification),
			});
			const button = analyzeRisk(locale);
			const reason = contentText(locale, "ai.noScansLeft");
			expect(button.getAttribute("aria-disabled")).toBe("true");
			expect(button.hasAttribute("disabled")).toBe(false);
			expect(button.getAttribute("title")).toBe(reason);
			expect(describedTexts(button)).toEqual([reason]);
			// La partie produit reste utilisable.
			expect(productButton().hasAttribute("aria-disabled")).toBe(false);
			button.click();
			// Le clic arrive à onAnalyze, qui ne fait rien sans analyse restante.
			expect(onAnalyze).toHaveBeenCalledTimes(1);
		},
	);

	test.each(["fr", "nl"] as const)(
		"%s : sans abonnement, l'action est un lien vers les formules",
		(locale) => {
			renderPill({
				locale,
				access: noSubscription,
				identification: done(sampleIdentification),
			});
			const link = screen.getByRole("link", {
				name: contentText(locale, "ai.analyzeRisk"),
			});
			expect(link.getAttribute("href")).toBe(PRICING);
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toBe("noopener noreferrer");
			expect(link.textContent).toBe(contentText(locale, "ai.analyzeRisk"));
			expect(
				screen.queryByRole("button", {
					name: contentText(locale, "ai.analyzeRisk"),
				}),
			).toBeNull();
			expect(productButton()).toBeTruthy();
		},
	);
});

describe("BadgePill : analyse du risque en cours", () => {
	test.each([
		["fr", "Démarrage de l'analyse"],
		["nl", "Analyse wordt gestart"],
	] as const)("%s : logo animé, « Steam Deck OLED · %s »", (locale, line) => {
		const { onToggle } = renderPill({
			locale,
			identification: done(sampleIdentification),
			ai: riskLoading(),
		});
		const pill = pillButton();
		expect(pill.getAttribute("aria-busy")).toBe("true");
		expect(pill.getAttribute("aria-expanded")).toBe("false");
		expect(pill.getAttribute("aria-label")).toBe(
			contentText(locale, "badge.aria"),
		);
		expect(
			pill.querySelector("svg")?.classList.contains("rq-logo--loading"),
		).toBe(true);
		expect(pill.querySelector("[data-reference]")?.textContent).toBe(
			"Steam Deck OLED",
		);
		expect(pill.textContent).toBe(`Steam Deck OLED·${line}`);
		expect(lineText()).toBe(line);
		// Seule la ligne d'état est annoncée.
		expect(screen.getByRole("status").textContent).toBe(line);
		pill.click();
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	test("la ligne suit les événements de l'analyse", () => {
		renderPill({
			identification: done(sampleIdentification),
			ai: riskLoading({ type: "stage", stage: "writing" }),
		});
		expect(lineText()).toBe("Rédige le verdict");
	});

	test("sans référence (produit non identifié) : la ligne d'état seule", () => {
		renderPill({ identification: done(none), ai: riskLoading() });
		const pill = pillButton();
		expect(pill.querySelector("[data-reference]")).toBeNull();
		expect(pill.textContent).toBe("Démarrage de l'analyse");
	});

	test("the pill never shows Identifier while the risk analysis replays the identification", () => {
		// L'analyse refait l'identification côté serveur : l'identification est
		// en cours en même temps que l'analyse.
		renderPill({
			identification: identifyLoading({
				type: "stage",
				stage: "reading_photos",
			}),
			ai: riskLoading(),
		});
		expect(
			screen.queryByRole("button", { name: "Identifier le produit" }),
		).toBeNull();
		expect(screen.queryByText("Identifier")).toBeNull();
		const pill = pillButton();
		expect(pill.getAttribute("aria-busy")).toBe("true");
		expect(lineText()).toBe("Démarrage de l'analyse");
	});
});

describe("BadgePill : résultat du risque", () => {
	test("point, niveau, séparateur, score : la pilule d'aujourd'hui, même après une identification", () => {
		const { onToggle } = renderPill({
			identification: done(sampleIdentification),
			ai: riskDone({ ...sampleAnalysis, level: "high", score: 82 }),
		});
		const pill = pillButton();
		expect(pill.getAttribute("aria-label")).toBe(
			contentText("fr", "badge.aria"),
		);
		expect(pill.textContent).toBe("Risque élevé82/100");
		expect(describedTexts(pill)).toEqual(["Risque élevé", "82/100"]);
		expect(pill.querySelector("[data-reference]")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Identifica/ })).toBeNull();
		pill.click();
		expect(onToggle).toHaveBeenCalledTimes(1);
	});
});

describe("BadgePill : erreur", () => {
	test.each(["fr", "nl"] as const)(
		"%s : identification en échec, logo atténué, message, séparateur et « Identifier »",
		async (locale) => {
			const user = userEvent.setup();
			const { onIdentify, onAnalyze } = renderPill({
				locale,
				identification: { status: "error", code: "analysis_failed" },
			});
			// Le message visible (avec son infobulle), pas la région annoncée.
			const message = screen.getByText(aiErrorText(locale, "analysis_failed"), {
				selector: "span[title]",
			});
			expect(message.classList.contains("text-text-2")).toBe(true);
			const action = screen.getByRole("button", {
				name: contentText(locale, "identify.launch"),
			});
			expect(action.textContent).toBe(
				contentText(locale, "identify.launchShort"),
			);
			expect(action.classList.contains("underline")).toBe(true);
			const pill = action.parentElement as HTMLElement;
			expect(pill.contains(message)).toBe(true);
			expect(pill.querySelector("svg")?.classList.contains("opacity-60")).toBe(
				true,
			);
			expect(screen.getByRole("status").textContent).toBe(
				aiErrorText(locale, "analysis_failed"),
			);
			await user.click(action);
			expect(onIdentify).toHaveBeenCalledTimes(1);
			expect(onAnalyze).not.toHaveBeenCalled();
		},
	);

	test("identification interrompue : « Relancer » relance l'identification", () => {
		const { onIdentify, onAnalyze } = renderPill({
			identification: { status: "error", code: "stream_interrupted" },
		});
		screen.getByRole("button", { name: contentText("fr", "ai.retry") }).click();
		expect(onIdentify).toHaveBeenCalledTimes(1);
		expect(onAnalyze).not.toHaveBeenCalled();
	});

	test.each(["fr", "nl"] as const)(
		"%s : analyse du risque interrompue, « Relancer » relance l'analyse, jamais l'identification",
		(locale) => {
			const { onIdentify, onAnalyze } = renderPill({
				locale,
				identification: done(sampleIdentification),
				ai: { status: "error", code: "stream_interrupted" },
			});
			expect(
				screen.getByText(aiErrorText(locale, "stream_interrupted"), {
					selector: "span[title]",
				}),
			).toBeTruthy();
			// L'erreur prend la place du produit dans la pilule.
			expect(screen.queryByRole("button", { name: /^Identifica/ })).toBeNull();
			screen
				.getByRole("button", { name: contentText(locale, "ai.retry") })
				.click();
			expect(onAnalyze).toHaveBeenCalledTimes(1);
			expect(onIdentify).not.toHaveBeenCalled();
		},
	);

	test("analyse du risque en échec : l'action « Analyser le risque », décrite par « Inclus » si incluse", () => {
		const { onAnalyze } = renderPill({
			identification: done(sampleIdentification),
			ai: { status: "error", code: "analysis_failed" },
			analysisIncluded: true,
			access: empty,
		});
		const action = analyzeRisk();
		expect(action.classList.contains("underline")).toBe(true);
		expect(describedTexts(action)).toEqual(["Inclus avec l'identification"]);
		action.click();
		expect(onAnalyze).toHaveBeenCalledTimes(1);
	});

	test("panneau ouvert : le message n'est plus dans la pilule", () => {
		renderPill({
			open: true,
			identification: { status: "error", code: "analysis_failed" },
		});
		expect(screen.queryByText(aiErrorText("fr", "analysis_failed"))).toBeNull();
	});

	test("quota relu à 0 : le message seul, la pilule focusable hors tabulation", () => {
		const { container } = renderPill({
			identification: { status: "error", code: "quota_exhausted" },
			access: empty,
		});
		expect(screen.queryByRole("button")).toBeNull();
		expect(container.querySelector('[tabindex="-1"]')).not.toBeNull();
	});
});
