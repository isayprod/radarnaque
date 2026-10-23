import type {
	IdentificationResult,
	Locale,
	ScanProgressEvent,
} from "@radarnaque/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { IdentifyPill } from "../components/IdentifyPill";
import type { IdentifyState } from "../lib/content/ai-client";
import {
	addEvent,
	type ScanProgress,
	startProgress,
} from "../lib/content/scan-progress";
import type { AiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { ContentAccess } from "../lib/messages";
import { sampleIdentification } from "./helpers";

afterEach(cleanup);

const active: ContentAccess = {
	status: "active",
	features: [],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
};
const PRICING = "http://localhost:8080/pricing/?lang=fr";

/** `AiScan` simulé : accès actif, rien en cours ; chaque test règle le reste. */
function scanWith(overrides: Partial<AiScan> = {}): AiScan {
	return {
		access: active,
		ai: { status: "idle" },
		identification: { status: "idle" },
		identify: vi.fn(),
		queued: false,
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

function renderPill(
	identification: IdentifyState,
	{
		locale = "fr",
		open = false,
		...overrides
	}: Partial<AiScan> & { locale?: Locale; open?: boolean } = {},
) {
	const onToggle = vi.fn();
	const onLaunch = vi.fn();
	const scan = scanWith({ identification, ...overrides });
	const view = render(
		<IdentifyPill
			scan={scan}
			locale={locale}
			open={open}
			onToggle={onToggle}
			onLaunch={onLaunch}
		/>,
	);
	return { ...view, scan, onToggle, onLaunch };
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

/** Le bouton de la pilule (repos, en cours, résultat). */
const pillButton = () => screen.getByRole("button");
/** Aucune couleur sémantique du risque dans la pilule. */
const SEMANTIC =
	/(^|\s)(text|bg|border)-(danger|warning|success|info)(-soft)?(\s|$)/;

describe("IdentifyPill : repos", () => {
	test.each([
		["fr", "Identifier", "Identifier le produit"],
		["nl", "Identificeren", "Product identificeren"],
	] as const)(
		"%s : logo et « %s », nom accessible « %s »",
		(locale, text, name) => {
			const { onLaunch } = renderPill({ status: "idle" }, { locale });
			const pill = screen.getByRole("button", { name });
			expect(pill.textContent).toBe(text);
			expect(pill.getAttribute("type")).toBe("button");
			expect(pill.hasAttribute("aria-expanded")).toBe(false);
			const logo = pill.querySelector("svg");
			expect(logo?.getAttribute("width")).toBe("16");
			expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
			// Même surface que « Analyser » : 28 px, verre sombre, anneau de focus.
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
			expect(onLaunch).toHaveBeenCalledTimes(1);
		},
	);

	test("lecture du magasin en cours : rien à cliquer", () => {
		const { container } = renderPill({ status: "idle" }, { restoring: true });
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(container.querySelector("svg")).toBeNull();
	});

	test("déconnecté : la pilule de repos, le clic passe par onLaunch (connexion)", () => {
		const { onLaunch } = renderPill(
			{ status: "idle" },
			{ access: { ...active, status: "signedOut" } as ContentAccess },
		);
		screen.getByRole("button", { name: "Identifier le produit" }).click();
		expect(onLaunch).toHaveBeenCalledTimes(1);
	});

	test.each(["fr", "nl"] as const)(
		"%s : sans abonnement, un lien vers les formules nommé comme la pilule",
		(locale) => {
			renderPill(
				{ status: "idle" },
				{
					locale,
					access: { ...active, status: "noSubscription" } as ContentAccess,
				},
			);
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
			const { onLaunch } = renderPill(
				{ status: "idle" },
				{ locale, access: { ...active, remaining: { scans: 0 } } },
			);
			const pill = screen.getByRole("button", {
				name: contentText(locale, "identify.launch"),
			});
			expect(pill.getAttribute("aria-disabled")).toBe("true");
			const reason = document.getElementById(
				pill.getAttribute("aria-describedby") ?? "",
			);
			expect(reason?.textContent).toBe(contentText(locale, "ai.noScansLeft"));
			pill.click();
			// Le clic arrive à onLaunch, qui ne fait rien sans analyse restante.
			expect(onLaunch).toHaveBeenCalledTimes(1);
		},
	);
});

describe("IdentifyPill : en cours", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		["fr", "Lecture des photos…"],
		["nl", "Foto's lezen…"],
	] as const)("%s : logo animé, ligne d'état « %s »", (locale, line) => {
		const { onToggle } = renderPill(
			{
				status: "loading",
				progress: progressOf({ type: "stage", stage: "reading_photos" }),
			},
			{ locale },
		);
		const pill = pillButton();
		expect(pill.getAttribute("aria-busy")).toBe("true");
		expect(pill.getAttribute("aria-expanded")).toBe("false");
		expect(pill.getAttribute("aria-label")).toBe(
			contentText(locale, "identify.launch"),
		);
		expect(
			pill.querySelector("svg")?.classList.contains("rq-logo--loading"),
		).toBe(true);
		expect(
			pill.querySelector(".radarnaque-status .rq-shimmer")?.textContent,
		).toBe(line);
		expect(screen.getByRole("status").textContent).toBe(line);
		pill.click();
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	test("ligne d'état : page lue, critères connus ; points de suspension après 4 s", () => {
		vi.useFakeTimers();
		renderPill({
			status: "loading",
			progress: progressOf(
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
		const props = {
			locale: "fr" as const,
			open: false,
			onToggle: () => {},
			onLaunch: () => {},
		};
		const { rerender } = render(<IdentifyPill scan={scan} {...props} />);
		const region = screen.getByRole("status");
		expect(region.getAttribute("aria-live")).toBe("polite");
		expect(region.textContent).toBe("");
		const at = (progress: ScanProgress) => (
			<IdentifyPill
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
		expect(document.querySelector(".rq-shimmer")?.textContent).toBe(
			"Vérification des critères…",
		);
		expect(region.textContent).toBe("Lecture des photos…");
		act(() => vi.advanceTimersByTime(1_999));
		expect(region.textContent).toBe("Lecture des photos…");
		act(() => vi.advanceTimersByTime(1));
		expect(region.textContent).toBe("Vérification des critères…");
	});
});

describe("IdentifyPill : résultat", () => {
	test.each([
		["fr", "Steam Deck OLED · Sûr 95 %"],
		["nl", "Steam Deck OLED · Zeker 95%"],
	] as const)(
		"%s : glyphe ●, référence, niveau, pourcentage",
		(locale, name) => {
			const { onToggle } = renderPill(done(sampleIdentification), { locale });
			const pill = screen.getByRole("button", { name });
			expect(pill.getAttribute("aria-expanded")).toBe("false");
			expect(pill.querySelector("[data-reference]")?.textContent).toBe(
				"Steam Deck OLED",
			);
			expect(pill.querySelector("[data-level]")?.textContent).toBe(
				name.split(" · ")[1],
			);
			const glyph = pill.querySelector("[data-glyph]");
			expect(glyph?.textContent).toBe("●");
			expect(glyph?.getAttribute("aria-hidden")).toBe("true");
			const percent = pill.querySelector("[data-percent]");
			expect(percent?.classList.contains("tabular-nums")).toBe(true);
			expect(pill.querySelector("svg")).toBeNull();
			pill.click();
			expect(onToggle).toHaveBeenCalledTimes(1);
		},
	);

	test("probable : glyphe ◐", () => {
		renderPill(done(probable));
		const pill = pillButton();
		expect(pill.querySelector("[data-glyph]")?.textContent).toBe("◐");
		expect(pill.getAttribute("aria-label")).toBe(
			"Steam Deck OLED · Probable 80 %",
		);
	});

	test.each([
		["fr", "Steam Deck OLED ou Steam Deck LCD ? · Incertain 55 %"],
		["nl", "Steam Deck OLED of Steam Deck LCD? · Onzeker 55%"],
	] as const)("%s : incertain, deux candidats et glyphe ○", (locale, name) => {
		renderPill(done(uncertain), { locale });
		const pill = screen.getByRole("button", { name });
		expect(pill.querySelector("[data-glyph]")?.textContent).toBe("○");
		expect(pill.querySelector("[data-reference]")?.textContent).toBe(
			name.split(" · ")[0],
		);
		expect(pill.querySelector("[data-level]")?.textContent).toBe(
			name.split(" · ")[1],
		);
	});

	test.each([
		["fr", "Produit non identifié"],
		["nl", "Product niet geïdentificeerd"],
	] as const)("%s : rien d'identifiable, « %s »", (locale, text) => {
		renderPill(done(none), { locale });
		const pill = screen.getByRole("button", { name: text });
		expect(pill.textContent).toBe(text);
		expect(pill.querySelector("[data-percent]")).toBeNull();
	});

	test("référence de plus de 32 caractères : tronquée avec « … », nom accessible complet", () => {
		const reference = "Apple MacBook Pro 14-pouces-M4-Max-2026-1To";
		renderPill(
			done({
				...sampleIdentification,
				objects: [
					{
						...(sampleIdentification
							.objects[0] as IdentificationResult["objects"][number]),
						reference,
					},
				],
			}),
		);
		const pill = pillButton();
		const shown = pill.querySelector("[data-reference]")?.textContent ?? "";
		expect(Array.from(shown)).toHaveLength(32);
		expect(shown).toBe(`${reference.slice(0, 31).trimEnd()}…`);
		expect(pill.getAttribute("aria-label")).toBe(`${reference} · Sûr 95 %`);
	});

	test("incertain, candidats longs : chacun tronqué à 32, nom accessible complet", () => {
		const a = "Apple MacBook Pro 14 pouces M4 Max 2026";
		const b = "Apple MacBook Pro 16 pouces M4 Max 2026";
		renderPill(
			done({
				...uncertain,
				objects: [
					{
						...(uncertain
							.objects[0] as IdentificationResult["objects"][number]),
						remaining: [a, b],
					},
				],
			}),
		);
		const pill = pillButton();
		const cut = (s: string) => `${s.slice(0, 31).trimEnd()}…`;
		expect(pill.querySelector("[data-reference]")?.textContent).toBe(
			`${cut(a)} ou ${cut(b)} ?`,
		);
		expect(pill.getAttribute("aria-label")).toBe(
			`${a} ou ${b} ? · Incertain 55 %`,
		);
	});

	test.each([
		["sûr", sampleIdentification],
		["probable", probable],
		["incertain", uncertain],
		["non identifié", none],
	])("%s : aucune couleur sémantique du risque", (_, result) => {
		const { container } = renderPill(done(result));
		for (const element of Array.from(container.querySelectorAll("*")))
			expect(element.getAttribute("class") ?? "").not.toMatch(SEMANTIC);
	});
});

describe("IdentifyPill : erreur", () => {
	test.each(["fr", "nl"] as const)(
		"%s : logo atténué, message de l'erreur, séparateur et « Identifier »",
		async (locale) => {
			const user = userEvent.setup();
			const { onLaunch } = renderPill(
				{ status: "error", code: "analysis_failed" },
				{ locale },
			);
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
			expect(onLaunch).toHaveBeenCalledTimes(1);
		},
	);

	test("flux interrompu : « Relancer »", () => {
		renderPill({ status: "error", code: "stream_interrupted" });
		expect(
			screen.getByRole("button", { name: contentText("fr", "ai.retry") }),
		).toBeTruthy();
	});

	test("panneau ouvert : le message n'est plus dans la pilule", () => {
		renderPill({ status: "error", code: "analysis_failed" }, { open: true });
		expect(screen.queryByText(aiErrorText("fr", "analysis_failed"))).toBeNull();
	});

	test("quota relu à 0 : le message seul, la pilule focusable hors tabulation", () => {
		const { container } = renderPill(
			{ status: "error", code: "quota_exhausted" },
			{ access: { ...active, remaining: { scans: 0 } } },
		);
		expect(screen.queryByRole("button")).toBeNull();
		expect(container.querySelector('[tabindex="-1"]')).not.toBeNull();
	});
});
