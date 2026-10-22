import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisResult, ScanProgressEvent } from "@radarnaque/shared";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { browser } from "wxt/browser";
import { RiskBadge } from "../components/RiskBadge";
import { createAccessCache, RECHECK_MS } from "../lib/content/access-policy";
import type { AiClient } from "../lib/content/ai-client";
import {
	type AiResultStore,
	listingFingerprint,
	type StoredAiResult,
} from "../lib/content/ai-results";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { Listing } from "../lib/listing/types";
import type { BgResponse, ContentAccess, ScanRequest } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";
import { debugAnalysis, sampleAnalysis, sampleDebug } from "./helpers";

afterEach(cleanup);

const listing: Listing = {
	site: "2ememain.be",
	externalId: "m123",
	url: "https://www.2ememain.be/v/velo/m123",
	title: "Vélo",
	description: "Bon état.",
	price: { amountCents: 15000, currency: "EUR" },
	priceType: "fixed",
	location: { city: "Namur" },
	images: [],
	seller: { id: "42", name: "Vendeur", reviewCount: 4 },
};

const active: ContentAccess = {
	status: "active",
	features: [],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
};

/** Issue d'une analyse simulée, réglée par chaque test. */
type ScanReply = (req: ScanRequest) => Promise<BgResponse<AnalysisResult>>;

/** Client IA simulé : accès actif, scans réussis. Recréé avant chaque test. */
let ai: AiClient & {
	access: ReturnType<typeof vi.fn<AiClient["access"]>>;
	scan: ReturnType<typeof vi.fn<AiClient["scan"]>>;
	openLogin: ReturnType<typeof vi.fn<AiClient["openLogin"]>>;
};
/** L'issue de chaque analyse (`done`), sans événement de progression. */
let scanReply: ReturnType<typeof vi.fn<ScanReply>>;
beforeEach(() => {
	scanReply = vi.fn<ScanReply>(async () => ({
		ok: true,
		data: sampleAnalysis,
	}));
	ai = {
		access: vi.fn<AiClient["access"]>(async () => ({ ok: true, data: active })),
		scan: vi.fn<AiClient["scan"]>((req) => ({
			done: scanReply(req),
			cancel: () => {},
		})),
		openLogin: vi.fn<AiClient["openLogin"]>(async () => ({
			ok: true,
			data: null,
		})),
	};
});

const low: RiskReport = {
	score: 0,
	level: "low",
	signals: [],
	rulesVersion: 1,
};
const high: RiskReport = {
	score: 90,
	level: "high",
	rulesVersion: 1,
	signals: [
		{ id: "short_description", weight: 10, severity: "info" },
		{ id: "no_reviews", weight: 10, severity: "warning" },
		{ id: "new_account", weight: 25, severity: "danger" },
	],
};
const medium: RiskReport = {
	score: 40,
	level: "medium",
	rulesVersion: 1,
	signals: [
		{ id: "new_account", weight: 25, severity: "danger" },
		{ id: "no_reviews", weight: 15, severity: "warning" },
	],
};
/** Textes de l'ancienne analyse locale : plus jamais affichés. */
const LOCAL_TEXTS = [
	"Compte vendeur très récent",
	"Aucun avis sur le vendeur",
	"Description très courte",
	"Analyse locale, sans IA",
	"Aucun signal d'alerte détecté.",
];
const aiHigh: AnalysisResult = {
	...sampleAnalysis,
	level: "high",
	score: 82,
	summary: { fr: "Arnaque probable.", nl: "Waarschijnlijk oplichting." },
};

const LAUNCH = contentText("fr", "ai.launch");
const PANEL_CLOSE = contentText("fr", "panel.close");
/** Pilule au repos : « Analyser », nommée « Analyser avec l'IA ». */
const launch = () => screen.getByRole("button", { name: LAUNCH });
const queryLaunch = () => screen.queryByRole("button", { name: LAUNCH });
/** Tous les contrôles de lancement de la pastille (bouton ou lien). */
const launchControls = (locale: "fr" | "nl" = "fr") => [
	...screen.queryAllByRole("button", {
		name: contentText(locale, "ai.launch"),
	}),
	...screen.queryAllByRole("link", { name: contentText(locale, "ai.launch") }),
];
/** Pilule d'une analyse en cours ou de son résultat : elle ouvre le panneau. */
const toggle = () => screen.getByRole("button", { name: /Radarnaque/ });
const findToggle = () => screen.findByRole("button", { name: /Radarnaque/ });
const described = () =>
	(toggle().getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent);

/** Accès déjà en cache (lu par une icône de carte, ou plus tôt). */
const cached = (access: ContentAccess) => {
	const cache = createAccessCache();
	cache.settle(cache.begin(), access);
	return cache;
};

/** Magasin simulé : une entrée par `site|externalId`. */
const storeWith = (entries: Record<string, StoredAiResult>): AiResultStore => ({
	get: async (site, id) => entries[`${site}|${id}`] ?? null,
	put: async () => {},
	prune: async () => {},
});

/** Lance l'analyse depuis la pilule et attend son résultat (`score`/100). */
async function launchToResult(
	user: ReturnType<typeof userEvent.setup>,
	score = sampleAnalysis.score,
) {
	await user.click(launch());
	await vi.waitFor(() =>
		expect(toggle().textContent).toContain(`${score}/100`),
	);
}

describe("RiskBadge", () => {
	test("au repos : une seule pilule « Analyser », aucun niveau ni score local", () => {
		const { container } = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
		);
		expect(container.textContent).not.toContain("Risque");
		expect(container.textContent).not.toContain("90/100");
		// Ni couleur de niveau, ni nom accessible qui l'évoquerait.
		expect(
			container.querySelector(".bg-danger, .bg-warning, .bg-success"),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /Radarnaque/ })).toBeNull();
		expect(launchControls()).toHaveLength(1);
		expect(launch().textContent).toBe(contentText("fr", "ai.launchShort"));
		expect(launch().getAttribute("type")).toBe("button");
		expect(launch().hasAttribute("aria-expanded")).toBe(false);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("au repos, le clic lance l'analyse (accès actif en cache) sans ouvrir de panneau", () => {
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		fireEvent.click(launch());
		expect(ai.scan).toHaveBeenCalledTimes(1);
		expect(ai.access).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("résultat IA : pilule niveau et score de l'IA, décrite par eux ; un clic ouvre le panneau, un second le ferme", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await launchToResult(user, 82);
		expect(toggle().textContent).toContain("Risque élevé");
		expect(toggle().textContent).not.toContain("40/100");
		expect(toggle().getAttribute("type")).toBe("button");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("fr", "badge.aria"),
		);
		expect(described()).toEqual(["Risque élevé", "82/100"]);
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(queryLaunch()).toBeNull();

		await user.click(toggle());
		expect(
			screen.getByRole("dialog", { name: contentText("fr", "panel.title") }),
		).toBeTruthy();
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});

	test("panneau : titre « Analyse Radarnaque », ni signaux locaux ni pied de page local", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await launchToResult(user, 82);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: "Analyse Radarnaque",
		});
		expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(
			"Analyse Radarnaque",
		);
		expect(dialog.textContent).toContain(aiHigh.summary.fr);
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		expect(dialog.textContent).not.toContain("90/100");
	});

	test("Escape ferme le panneau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});

	test("un clic hors de la pastille ferme le panneau, un clic dedans non", async () => {
		const user = userEvent.setup();
		render(
			<div>
				<button type="button">ailleurs</button>
				<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />
			</div>,
		);
		await launchToResult(user);
		await user.click(toggle());
		await user.click(screen.getByRole("dialog"));
		expect(screen.getByRole("dialog")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "ailleurs" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("dans un Shadow DOM : clic à l'intérieur conservé, clic sur la page ferme", async () => {
		const user = userEvent.setup();
		const host = document.createElement("div");
		document.body.append(host);
		const outside = document.createElement("button");
		outside.textContent = "page";
		document.body.append(outside);
		const shadow = host.attachShadow({ mode: "open" });
		const container = document.createElement("div");
		shadow.append(container);
		const view = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
			{ container },
		);
		await user.click(within(container).getByRole("button", { name: LAUNCH }));
		await user.click(
			await within(container).findByRole("button", { name: /Radarnaque/ }),
		);
		await user.click(within(container).getByRole("dialog"));
		expect(within(container).queryByRole("dialog")).not.toBeNull();
		await user.click(outside);
		expect(within(container).queryByRole("dialog")).toBeNull();
		view.unmount();
		host.remove();
		outside.remove();
	});

	test("locale nl : libellés en néerlandais", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(<RiskBadge report={high} listing={listing} locale="nl" ai={ai} />);
		const button = screen.getByRole("button", {
			name: contentText("nl", "ai.launch"),
		});
		expect(button.textContent).toBe("Analyseren");
		await user.click(button);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(toggle().textContent).toContain("Hoog risico");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("nl", "badge.aria"),
		);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("nl", "panel.title"),
		});
		expect(dialog.textContent).toContain(aiHigh.summary.nl);
		expect(dialog.textContent).not.toContain("Zeer recent verkopersaccount");
	});

	test("lancer l'analyse ne passe que par le client IA injecté : ni fetch, ni sendMessage direct", async () => {
		const user = userEvent.setup();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		// Ouvrir le panneau ne relance rien.
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("Escape ouvert est consommé : un écouteur document ultérieur ne le reçoit pas", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		const bubble = vi.fn();
		const capture = vi.fn();
		document.addEventListener("keydown", bubble);
		document.addEventListener("keydown", capture, true);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(bubble).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		// Panneau fermé : Escape n'est plus intercepté.
		await user.keyboard("{Escape}");
		expect(bubble).toHaveBeenCalledTimes(1);
		document.removeEventListener("keydown", bubble);
		document.removeEventListener("keydown", capture, true);
	});
});

describe("RiskBadge : panneau", () => {
	/** Résultat high 82, panneau ouvert. */
	const openHigh = async (
		user: ReturnType<typeof userEvent.setup>,
		locale: "fr" | "nl" = "fr",
	) => {
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale={locale}
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: contentText(locale, "ai.launch") }),
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		await user.click(toggle());
		return screen.getByRole("dialog", {
			name: contentText(locale, "panel.title"),
		});
	};

	test("panneau : en-tête avec le titre et un bouton « Fermer » qui ferme et rend le focus à la pilule", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		const header = dialog.firstElementChild;
		if (!header) throw new Error("en-tête attendu");
		// Logo 14 px, titre en style label, bouton de fermeture.
		const logo = header.querySelector("svg");
		expect(logo?.getAttribute("width")).toBe("14");
		expect(logo?.getAttribute("aria-hidden")).toBe("true");
		const title = within(header as HTMLElement).getByRole("heading", {
			level: 2,
		});
		expect(title.textContent).toBe("Analyse Radarnaque");
		for (const name of ["uppercase", "text-[11px]", "tracking-[0.06em]"])
			expect(title.classList.contains(name), name).toBe(true);
		const close = within(header as HTMLElement).getByRole("button", {
			name: "Fermer",
		});
		expect(close.getAttribute("type")).toBe("button");
		// Icône Lucide « close » : deux traits, décorative.
		const icon = close.querySelector("svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(icon?.querySelectorAll("path")).toHaveLength(2);

		await user.click(close);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(toggle());
	});

	test("fermer au clavier : Entrée sur « Fermer », le focus revient à la pilule", async () => {
		const user = userEvent.setup();
		await openHigh(user);
		screen.getByRole("button", { name: "Fermer" }).focus();
		await user.keyboard("{Enter}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(toggle());
	});

	test("nl : « Sluiten »", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user, "nl");
		const close = within(dialog).getByRole("button", { name: "Sluiten" });
		await user.click(close);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("carte : verre sombre, bordure, --r-m, ombre flottante, filet en dégradé, 340 px au plus 90 vw", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		for (const name of [
			"bg-glass-host",
			"border-border-default",
			"rounded-md",
			"shadow-[var(--shadow-float)]",
			"w-[340px]",
			"max-w-[90vw]",
			"z-[2147483000]",
			"before:bg-[image:var(--gradient-hairline)]",
			"before:h-0.5",
		])
			expect(dialog.classList.contains(name), name).toBe(true);
		expect(dialog.className).not.toMatch(
			/\bslate-|\bbg-white(?![\w/])|2147483647/,
		);
	});

	test("filet : le dégradé forme le bord haut, sans bordure grise au-dessus (border-t-0)", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		expect(dialog.classList.contains("border-t-0")).toBe(true);
		expect(dialog.classList.contains("before:top-0")).toBe(true);
	});

	test("pilule près du bord droit : le panneau est décalé vers la gauche, la page ne défile pas", async () => {
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
			1280,
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const shift = Number.parseFloat(this.style.left || "0");
				return DOMRect.fromRect({ x: 1100 + shift, y: 0, width: 340 });
			},
		);
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		expect(dialog.style.left).toBe("-168px");
	});

	test("contraste : la pilule et le panneau sont en verre opaque des pages tierces (bg-glass-host), jamais bg-glass-strong", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		for (const surface of [toggle(), dialog]) {
			expect(surface.classList.contains("bg-glass-host")).toBe(true);
			expect(surface.classList.contains("bg-glass-strong")).toBe(false);
		}
	});

	test("aucune classe z-[2147483647] dans RiskBadge", () => {
		const source = readFileSync(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				"../components/RiskBadge.tsx",
			),
			"utf8",
		);
		expect(source).not.toContain("2147483647");
		expect(source).toContain("z-[2147483000]");
	});

	test("résultat dans le panneau : score serif, badge de verdict, barre", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		const score = within(dialog).getByText("82");
		expect(score.classList.contains("font-serif")).toBe(true);
		expect(score.nextElementSibling?.textContent).toBe("/100");
		expect(
			within(dialog).getByText("Risque élevé").closest("[data-verdict]"),
		).not.toBeNull();
		const fill = dialog.querySelector("[role='presentation']")
			?.firstElementChild as HTMLElement | null;
		expect(fill?.style.width).toBe("82%");
	});
});

describe("RiskBadge : analyse IA", () => {
	/** Bouton « Lancer une analyse IA » du panneau, affiché une fois l'accès chargé. */
	const findRun = () =>
		screen.findByRole("button", { name: contentText("fr", "ai.run") });
	/** Déconnecté, popup de connexion impossible : le clic ouvre le panneau. */
	const signedOutWithoutPopup = () => {
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
	};

	test("analyse lancée, panneau fermé puis rouvert : le résultat reste, un seul scan", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		expect(screen.getByText(sampleAnalysis.summary.fr)).toBeTruthy();

		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(toggle());
		expect(screen.getByText(sampleAnalysis.summary.fr)).toBeTruthy();
		expect(ai.scan).toHaveBeenCalledTimes(1);
		// Le composant est resté monté : seul le panneau s'est fermé.
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
	});

	test("la demande d'analyse contient toujours signals et rulesVersion du rapport local", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await vi.waitFor(() => expect(ai.scan).toHaveBeenCalledTimes(1));
		expect(ai.scan).toHaveBeenCalledWith(
			{
				listing,
				signals: high.signals,
				rulesVersion: high.rulesVersion,
				trigger: "button",
				partial: false,
			},
			expect.any(Function),
		);
	});

	test("double clic sur « Analyser » : une seule requête", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.dblClick(launch());
		await findToggle();
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("R3 : session expirée pendant un scan, l'accès relu (signedOut) ne laisse que la connexion", async () => {
		const user = userEvent.setup();
		ai.access
			.mockResolvedValueOnce({ ok: true, data: active })
			.mockResolvedValueOnce({ ok: true, data: { status: "signedOut" } });
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		// Analyse en cours : le panneau est ouvert sur son déroulé.
		await user.click(await findToggle());
		await act(async () =>
			answer({ ok: false, error: { code: "session_expired" } }),
		);

		const dialog = screen.getByRole("dialog");
		await within(dialog).findByText(contentText("fr", "ai.loginHint"));
		expect(ai.access).toHaveBeenCalledTimes(2);
		expect(
			screen.queryByRole("button", { name: contentText("fr", "ai.run") }),
		).toBeNull();
		expect(
			screen.getAllByRole("button", { name: contentText("fr", "ai.login") }),
		).toHaveLength(1);
	});

	test("R8 : accès en erreur, le clic ouvre le panneau ; nouvel essai après 30 s seulement, puis le bouton d'analyse", async () => {
		const user = userEvent.setup();
		let clock = 0;
		const accessCache = createAccessCache(() => clock);
		ai.access.mockResolvedValueOnce({
			ok: false,
			error: { code: "background_unavailable" },
		});
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		await user.click(launch());
		await screen.findByText(aiErrorText("fr", "background_unavailable"));
		expect(screen.getByRole("dialog")).toBeTruthy();
		await user.keyboard("{Escape}");
		await user.click(launch());
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(ai.access).toHaveBeenCalledTimes(1);
		await user.keyboard("{Escape}");
		clock += RECHECK_MS;
		await user.click(launch());
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(2);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("signedOut, panneau ouvert, retour sur l'onglet (focus) : accès relu, le panneau passe à active", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		const reads = ai.access.mock.calls.length;

		// Connexion faite dans la popup ; la page reprend le focus.
		ai.access.mockImplementation(async () => ({ ok: true, data: active }));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(reads + 1);
		expect(screen.queryByText(contentText("fr", "ai.loginHint"))).toBeNull();
	});

	test("signedOut, panneau ouvert, onglet de nouveau visible : accès relu", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		const reads = ai.access.mock.calls.length;
		ai.access.mockImplementation(async () => ({ ok: true, data: active }));
		const state = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("visible");
		fireEvent(document, new Event("visibilitychange"));
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(reads + 1);
		state.mockRestore();
	});

	test("accès actif : focus ou panneau rouvert ne relisent pas l'accès", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		// Lu au clic, puis relu après le scan.
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(2));
		await user.click(toggle());
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await user.click(toggle());
		await user.click(toggle());
		expect(ai.access).toHaveBeenCalledTimes(2);
	});

	test("panneau fermé : focus ne relit pas l'accès", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		await user.keyboard("{Escape}");
		const reads = ai.access.mock.calls.length;
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(ai.access).toHaveBeenCalledTimes(reads);
	});

	test("no photo-scan button : une seule action dans le panneau, avec ou sans photos", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(
			<RiskBadge
				report={high}
				listing={{ ...listing, images: ["https://images.example/1.jpg"] }}
				locale="fr"
				ai={ai}
			/>,
		);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		ai.access.mockImplementation(async () => ({ ok: true, data: active }));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await findRun();
		// Une seule action, en plus du bouton « Fermer » de l'en-tête.
		const actions = within(screen.getByRole("dialog"))
			.getAllByRole("button")
			.filter((b) => b.getAttribute("aria-label") !== PANEL_CLOSE);
		expect(actions).toHaveLength(1);
		expect(screen.queryByText(/photos/)).toBeNull();
	});

	test("description modifiée puis clic : la requête porte la nouvelle description", () => {
		const accessCache = cached(active);
		const view = render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		view.rerender(
			<RiskBadge
				report={high}
				listing={{ ...listing, description: "Description complétée." }}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		fireEvent.click(launch());
		expect(ai.scan.mock.calls[0]?.[0].listing.description).toBe(
			"Description complétée.",
		);
	});

	test("sans abonnement, accès inconnu : le clic ouvre le panneau, lien vers les formules dans la langue active", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({
			ok: true,
			data: { status: "noSubscription" },
		});
		render(<RiskBadge report={high} listing={listing} locale="nl" ai={ai} />);
		await user.click(
			screen.getByRole("button", { name: contentText("nl", "ai.launch") }),
		);
		const link = await screen.findByRole("link", {
			name: contentText("nl", "ai.pricing"),
		});
		expect(link.getAttribute("href")).toBe(
			"http://localhost:8080/pricing/?lang=nl",
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("Se connecter sans popup disponible : texte de repli, le clic dans le panneau ne le ferme pas", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginFallback"));
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "ai.login") }),
		);
		expect(ai.openLogin).toHaveBeenCalledTimes(2);
		expect(
			screen.getByText(contentText("fr", "ai.loginFallback")),
		).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});

describe("RiskBadge : pilule et ligne en direct", () => {
	afterEach(() => vi.useRealTimers());

	const searchEvent: ScanProgressEvent = {
		type: "search",
		id: 1,
		query: "iPhone 18 Pro prix",
		aspect: "price",
	};
	const SEARCH_LINE = "Recherche web (prix du marché) : “iPhone 18 Pro prix”";

	/** Envoie un événement du flux à l'analyse lancée en dernier. */
	const emit = (e: ScanProgressEvent) => {
		const onEvent = ai.scan.mock.calls.at(-1)?.[1];
		if (!onEvent) throw new Error("aucune analyse lancée");
		act(() => onEvent(e));
	};
	const statusLineEl = () => toggle().querySelector(".radarnaque-status");
	const announced = () => screen.getByRole("status").textContent;

	test("launch button starts scan without opening panel", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		expect(ai.access).not.toHaveBeenCalled();
		const button = launch();
		expect(button.getAttribute("type")).toBe("button");
		expect(button.textContent).toBe("Analyser");
		await user.click(button);
		// Accès inconnu : lu d'abord, puis l'analyse part. Elle part dans un effet,
		// après la réponse de l'accès (hors `act`) : `ai.scan` est appelé avant le
		// rendu de l'état `loading`. On attend donc ce rendu, pas l'appel.
		await vi.waitFor(() =>
			expect(toggle().querySelector(".rq-logo--loading")).not.toBeNull(),
		);
		expect(ai.scan).toHaveBeenCalledTimes(1);
		expect(ai.access).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		// Pendant l'analyse, la ligne en direct remplace « Analyser ».
		expect(queryLaunch()).toBeNull();
		expect(toggle().textContent).not.toContain("90/100");
	});

	test("analyse en cours : le clic ouvre le panneau avec le déroulé", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		emit(searchEvent);
		await user.click(toggle());
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.textContent).toContain(contentText("fr", "ai.loading"));
		expect(within(dialog).getByText(SEARCH_LINE)).toBeTruthy();
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("absent dès qu'un résultat IA est affiché", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		expect(queryLaunch()).toBeNull();
	});

	test("launch button when signed out opens login", async () => {
		const user = userEvent.setup();
		// Chaque réponse du service worker est un objet neuf (clone du message).
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await vi.waitFor(() => expect(ai.openLogin).toHaveBeenCalledTimes(1));
		expect(ai.scan).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
		// Déjà connu signedOut : relu (R8), puis la connexion à nouveau.
		await user.click(launch());
		await vi.waitFor(() => expect(ai.openLogin).toHaveBeenCalledTimes(2));
		expect(ai.access).toHaveBeenCalledTimes(2);
	});

	test("launch disabled when no scans left", async () => {
		const user = userEvent.setup();
		const empty: ContentAccess = { ...active, remaining: { scans: 0 } };
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(empty)}
			/>,
		);
		const button = launch();
		// Grisé mais focusable : la raison est lue avec le bouton.
		expect(button.hasAttribute("disabled")).toBe(false);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("title")).toBe("Plus d'analyses IA disponibles");
		const reason = document.getElementById(
			button.getAttribute("aria-describedby") ?? "",
		);
		expect(reason?.textContent).toBe("Plus d'analyses IA disponibles");
		button.focus();
		expect(document.activeElement).toBe(button);
		await user.click(button);
		expect(ai.scan).not.toHaveBeenCalled();
		expect(ai.access).not.toHaveBeenCalled();
		cleanup();

		// Accès inconnu au clic : lu, puis grisé sans analyse.
		ai.access.mockResolvedValue({ ok: true, data: empty });
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await vi.waitFor(() =>
			expect(launch().getAttribute("aria-disabled")).toBe("true"),
		);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("accès relu pendant que le panneau est ouvert (signedOut → sans abonnement) : la pilule devient le lien vers les formules, un seul contrôle de lancement", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginFallback"));
		expect(launchControls()).toHaveLength(1);

		// Connexion faite dans la popup, sans abonnement ; la page reprend le focus.
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "noSubscription" },
		}));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		const link = await screen.findByRole("link", { name: LAUNCH });
		expect(link.getAttribute("href")).toMatch(/\/pricing\/\?lang=fr$/);
		expect(link.textContent).toBe(contentText("fr", "ai.launchShort"));
		expect(launchControls()).toHaveLength(1);
		expect(queryLaunch()).toBeNull();
		// Le panneau, toujours ouvert, dit pourquoi.
		expect(screen.getByRole("dialog").textContent).toContain(
			aiErrorText("fr", "no_active_subscription"),
		);
	});

	test("accès relu à 0 analyse : la pilule reste focusable, aria-disabled, décrite par ai.noScansLeft", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		await screen.findByText(contentText("fr", "ai.loginFallback"));

		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await vi.waitFor(() =>
			expect(launch().getAttribute("aria-disabled")).toBe("true"),
		);
		const button = launch();
		expect(button.hasAttribute("disabled")).toBe(false);
		const reason = contentText("fr", "ai.noScansLeft");
		expect(button.getAttribute("title")).toBe(reason);
		expect(
			document.getElementById(button.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe(reason);
		button.focus();
		expect(document.activeElement).toBe(button);
		expect(launchControls()).toHaveLength(1);
		await user.click(button);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("analysis_failed lancée depuis la pastille : son texte, annoncé, et le bouton de lancement", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "analysis_failed" },
		});
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		const text = aiErrorText("fr", "analysis_failed");
		expect(await screen.findByText(text)).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		await vi.waitFor(() => expect(announced()).toBe(text), { timeout: 3_000 });
		// Pas « Relancer » : le bouton de lancement, qui relance l'analyse.
		expect(screen.queryByRole("button", { name: "Relancer" })).toBeNull();
		expect(launchControls()).toHaveLength(1);
		await user.click(launch());
		expect(ai.scan).toHaveBeenCalledTimes(2);
	});

	test("quota_exhausted lancée depuis la pastille : son texte, sans bouton (quota relu à 0)", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "quota_exhausted" },
		});
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		expect(
			await screen.findByText(aiErrorText("fr", "quota_exhausted")),
		).toBeTruthy();
		// L'accès relu après le scan dit 0 : le message suffit.
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(queryLaunch()).toBeNull());
	});

	test("analyse interrompue, accès relu à 0 : ni « Relancer » muet, ni bouton de lancement", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		expect(
			await screen.findByText(aiErrorText("fr", "stream_interrupted")),
		).toBeTruthy();
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: "Relancer" })).toBeNull(),
		);
		expect(queryLaunch()).toBeNull();
	});

	test("échec d'une analyse suivie dans le panneau ouvert : son texte dans le panneau seulement", async () => {
		const user = userEvent.setup();
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		await act(async () =>
			answer({ ok: false, error: { code: "analysis_failed" } }),
		);
		const text = aiErrorText("fr", "analysis_failed");
		expect(await within(dialog).findByText(text)).toBeTruthy();
		// Ni dans la pastille, ni dans sa région annoncée : le panneau a sa propre alerte.
		expect(screen.getAllByText(text)).toHaveLength(1);
		// La dernière ligne d'état laisse place au vide (2 s plus tard), pas à l'erreur.
		await vi.waitFor(() => expect(announced()).toBe(""), { timeout: 3_000 });

		// Panneau fermé : l'erreur revient dans la pastille.
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(await screen.findAllByText(text)).not.toHaveLength(0);
	});

	test("connexion impossible depuis la pastille : le panneau s'ouvre avec le texte de repli", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(launch());
		const fallback = contentText("fr", "ai.loginFallback");
		expect(await screen.findByText(fallback)).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();

		// Déjà su impossible : le panneau rouvre dès le clic.
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(launch());
		expect(await screen.findByText(fallback)).toBeTruthy();
	});

	test("sans abonnement : un lien vers les formules, dans la langue active", () => {
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="nl"
				ai={ai}
				accessCache={cached({ status: "noSubscription" })}
			/>,
		);
		const link = screen.getByRole("link", { name: "Analyseren met AI" });
		expect(link.getAttribute("href")).toMatch(/\/pricing\/\?lang=nl$/);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener");
		expect(launchControls("nl")).toHaveLength(1);
	});

	test("live line follows last event", () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		fireEvent.click(launch());
		expect(statusLineEl()?.textContent).toBe("Démarrage de l'analyse");
		emit({ type: "stage", stage: "photos", count: 3 });
		expect(statusLineEl()?.textContent).toBe("Téléchargement de 3 photos");
		emit(searchEvent);
		expect(within(toggle()).getByText(SEARCH_LINE)).toBeTruthy();
		expect(statusLineEl()?.textContent).toBe(SEARCH_LINE);
		// Le nom du bouton ne change pas pendant l'analyse.
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("fr", "badge.aria"),
		);
	});

	test("waiting class after 4s", () => {
		vi.useFakeTimers();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		fireEvent.click(launch());
		emit(searchEvent);
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(false);
		act(() => vi.advanceTimersByTime(3_999));
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(false);
		act(() => vi.advanceTimersByTime(1));
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(true);
		// La ligne garde le dernier texte.
		expect(statusLineEl()?.textContent).toBe(SEARCH_LINE);
		emit({ type: "stage", stage: "writing" });
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(false);
	});

	test("aria-live throttled to 2s", () => {
		vi.useFakeTimers();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		const region = screen.getByRole("status");
		expect(region.getAttribute("aria-live")).toBe("polite");
		expect(region.textContent).toBe("");
		fireEvent.click(launch());
		expect(announced()).toBe("Démarrage de l'analyse");
		emit({ type: "stage", stage: "photos", count: 3 });
		emit(searchEvent);
		// La ligne visible suit chaque événement ; la région annoncée attend.
		expect(statusLineEl()?.textContent).toBe(SEARCH_LINE);
		expect(announced()).toBe("Démarrage de l'analyse");
		act(() => vi.advanceTimersByTime(1_999));
		expect(announced()).toBe("Démarrage de l'analyse");
		act(() => vi.advanceTimersByTime(1));
		expect(announced()).toBe(SEARCH_LINE);
		act(() => vi.advanceTimersByTime(500));
		emit({ type: "stage", stage: "writing" });
		expect(announced()).toBe(SEARCH_LINE);
		act(() => vi.advanceTimersByTime(1_499));
		expect(announced()).toBe(SEARCH_LINE);
		act(() => vi.advanceTimersByTime(1));
		expect(announced()).toBe("Rédige le verdict");
	});

	test.each(["stream_interrupted", "timeout"])(
		"interrupted shows relaunch (%s)",
		async (code) => {
			const user = userEvent.setup();
			scanReply.mockResolvedValueOnce({ ok: false, error: { code } });
			render(
				<RiskBadge
					report={high}
					listing={listing}
					locale="fr"
					ai={ai}
					accessCache={cached(active)}
				/>,
			);
			await user.click(launch());
			expect(await screen.findByText(aiErrorText("fr", code))).toBeTruthy();
			// Jamais un logo qui tourne sans fin.
			expect(document.querySelector(".rq-logo--loading")).toBeNull();
			expect(queryLaunch()).toBeNull();
			expect(screen.queryByRole("dialog")).toBeNull();
			await user.click(screen.getByRole("button", { name: "Relancer" }));
			expect(ai.scan).toHaveBeenCalledTimes(2);
			await vi.waitFor(() => expect(toggle().textContent).toContain("55/100"));
		},
	);

	test("model text rendered as text", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		const { container } = render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		const text = "<img src=x onerror=alert(1)>";
		emit({ type: "thinking", part: 1, text });
		expect(container.querySelector("img")).toBeNull();
		expect(statusLineEl()?.textContent).toBe(text);
		// Le déroulé du panneau aussi.
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(text)).toBeTruthy();
		expect(container.querySelector("img")).toBeNull();
	});

	// Design de la pilule (verre sombre, logo, reflet de la ligne d'état).
	const logoOf = (element: Element) => element.querySelector("svg");

	test("au repos : le logo est présent, sans rq-logo--loading", () => {
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		const pill = launch();
		const logo = logoOf(pill);
		expect(logo).not.toBeNull();
		expect(logo?.getAttribute("aria-hidden")).toBe("true");
		expect(logo?.getAttribute("width")).toBe("16");
		expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
		expect(pill.textContent).toBe(contentText("fr", "ai.launchShort"));
		// Verre sombre, Inter, anneau de focus au clavier.
		for (const name of [
			"h-7",
			"rounded-pill",
			"bg-glass-host",
			"supports-[backdrop-filter]:backdrop-blur-[18px]",
			"border-white/12",
			"shadow-[var(--shadow-pill)]",
			"font-sans",
			"text-[13px]",
			"font-medium",
			"text-text-1",
			"focus-visible:shadow-[var(--focus-ring)]",
		])
			expect(pill.classList.contains(name), name).toBe(true);
		// Plus aucune couleur Tailwind brute.
		expect(pill.className).not.toMatch(
			/slate-|white\b(?!\/)|red-|green-|amber-/,
		);
	});

	test("en cours : le logo porte rq-logo--loading et la ligne d'état rq-shimmer ; plus aucun radarnaque-spin", () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		fireEvent.click(launch());
		emit(searchEvent);
		const logo = logoOf(toggle());
		expect(logo?.classList.contains("rq-logo--loading")).toBe(true);
		expect(logo?.querySelector(".rq-logo-spin .rq-logo-arc")).not.toBeNull();
		const text = statusLineEl()?.querySelector(".rq-shimmer");
		expect(text?.textContent).toBe(SEARCH_LINE);
		expect(document.querySelector(".radarnaque-spin")).toBeNull();
		expect(document.querySelector(".radarnaque-fade")).toBeNull();
	});

	test("résultat : point, niveau en toutes lettres, séparateur, score ; la couleur vient de LEVEL_STYLE (bg-danger pour high)", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await launchToResult(user, 82);
		const [dot, level, separator, score, ...rest] = Array.from(
			toggle().children,
		);
		expect(rest).toHaveLength(0);
		expect(dot?.getAttribute("aria-hidden")).toBe("true");
		expect(dot?.classList.contains("bg-danger")).toBe(true);
		expect(dot?.classList.contains("size-2")).toBe(true);
		expect(level?.textContent).toBe("Risque élevé");
		expect(separator?.getAttribute("aria-hidden")).toBe("true");
		expect(separator?.textContent).toBe("");
		expect(score?.textContent).toBe("82/100");
		expect(score?.classList.contains("text-text-2")).toBe(true);
		expect(score?.classList.contains("tabular-nums")).toBe(true);
		// Pas de logo qui tourne avec un résultat.
		expect(toggle().querySelector(".rq-logo--loading")).toBeNull();
	});

	test("erreur : logo sans animation et à 60 % d'opacité, message, « Relancer »", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		const message = await screen.findByText(
			aiErrorText("fr", "stream_interrupted"),
		);
		expect(message.classList.contains("text-text-2")).toBe(true);
		const relaunch = screen.getByRole("button", { name: "Relancer" });
		expect(relaunch.classList.contains("underline")).toBe(true);
		const pill = relaunch.parentElement as HTMLElement;
		expect(pill.contains(message)).toBe(true);
		expect(pill.classList.contains("bg-glass-host")).toBe(true);
		const logo = logoOf(pill);
		expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
		expect(logo?.classList.contains("opacity-60")).toBe(true);
	});

	test("ligne d'état de 200 caractères : tronquée (classe truncate) dans une pilule bornée à 340 px", () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		fireEvent.click(launch());
		const query = "iPhone 18 Pro ".repeat(15).slice(0, 200);
		emit({ type: "search", id: 2, query, aspect: "price" });
		const pill = toggle();
		expect(pill.classList.contains("max-w-[340px]")).toBe(true);
		expect(pill.classList.contains("min-w-0")).toBe(true);
		const text = statusLineEl()?.querySelector(".rq-shimmer");
		// `statusLine` coupe déjà le texte ; la pilule le tronque encore à l'affichage.
		expect(text?.textContent).toMatch(
			/^Recherche web \(prix du marché\) : “iPhone 18 Pro/,
		);
		expect(text?.classList.contains("truncate")).toBe(true);
		expect(text?.classList.contains("min-w-0")).toBe(true);
		expect(statusLineEl()?.classList.contains("min-w-0")).toBe(true);
		// Le logo ne rétrécit pas : seul le texte est tronqué.
		expect(logoOf(pill)?.classList.contains("shrink-0")).toBe(true);
	});

	test("lancée au clavier, l'analyse garde le focus sur la pilule", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		const pill = launch();
		pill.focus();
		await user.keyboard("{Enter}");
		expect(ai.scan).toHaveBeenCalledTimes(1);
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		// Le même élément passe du repos à l'analyse en cours.
		expect(toggle()).toBe(pill);
		expect(document.activeElement).toBe(pill);
	});

	test("lancée au clavier avec un accès inconnu : le focus reste sur la pilule une fois l'accès lu", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		const pill = launch();
		pill.focus();
		await user.keyboard("{Enter}");
		await vi.waitFor(() =>
			expect(toggle().getAttribute("aria-busy")).toBe("true"),
		);
		expect(document.activeElement).toBe(toggle());
	});

	test("panneau ouvert après une erreur, accès relu à 0 : la pilule garde le logo atténué, jamais vide", async () => {
		const user = userEvent.setup();
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		const { container } = render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(launch());
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		await act(async () =>
			answer({ ok: false, error: { code: "quota_exhausted" } }),
		);
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalled());
		await vi.waitFor(() => expect(launchControls()).toHaveLength(0));
		expect(screen.queryByRole("button", { name: "Relancer" })).toBeNull();
		// Le texte de l'erreur reste dans le panneau seulement.
		expect(
			within(dialog).getByText(aiErrorText("fr", "quota_exhausted")),
		).toBeTruthy();
		const logos = Array.from(container.querySelectorAll("svg")).filter(
			(svg) => !dialog.contains(svg),
		);
		expect(logos).toHaveLength(1);
		expect(logos[0]?.classList.contains("opacity-60")).toBe(true);
		expect(logos[0]?.closest(".bg-glass-host")).not.toBeNull();
	});
});

describe("RiskBadge : seule l'IA donne un résultat", () => {
	test("résultat repris du magasin : niveau et score affichés tout de suite, aucun scan, aucun « Analyser »", async () => {
		const user = userEvent.setup();
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: aiHigh,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		const { container } = render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
				accessCache={cached(active)}
			/>,
		);
		// Premier rendu, magasin pas encore lu : aucun « Analyser » à cliquer, qui
		// lancerait un vrai scan (accès actif en cache) sur une fiche déjà analysée.
		expect(launchControls()).toHaveLength(0);
		expect(container.textContent).not.toContain(
			contentText("fr", "ai.launchShort"),
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(toggle().textContent).toContain("Risque élevé");
		expect(described()).toEqual(["Risque élevé", "82/100"]);
		expect(launchControls()).toHaveLength(0);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.textContent).toContain(aiHigh.summary.fr);
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("fiche sans résultat en magasin : « Analyser » apparaît une fois la lecture finie", async () => {
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={storeWith({})}
			/>,
		);
		expect(launchControls()).toHaveLength(0);
		await vi.waitFor(() => expect(launchControls()).toHaveLength(1));
		expect(launch().textContent).toBe(contentText("fr", "ai.launchShort"));
	});

	test("magasin dont la lecture échoue : « Analyser » apparaît, jamais une pastille vide", async () => {
		const failing: AiResultStore = {
			...storeWith({}),
			get: async () => {
				throw new Error("stockage indisponible");
			},
		};
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={failing}
			/>,
		);
		await vi.waitFor(() => expect(launchControls()).toHaveLength(1));
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("I2 : résultat repris, puis prix changé sous la même clé : retour à « Analyser », sans score", async () => {
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: aiHigh,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		const view = render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		view.rerender(
			<RiskBadge
				report={medium}
				listing={{
					...listing,
					price: { amountCents: 9000, currency: "EUR" },
				}}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		expect(launchControls()).toHaveLength(1);
		expect(view.container.textContent).not.toContain("/100");
		expect(ai.scan).not.toHaveBeenCalled();
	});
});

describe("RiskBadge : section Debug (superuser)", () => {
	const superuser: ContentAccess = { ...active, unlimited: true, debug: true };
	const debugTitle = contentText("fr", "debug.title");
	/** Analyse lancée depuis la pilule, puis panneau ouvert sur son résultat. */
	const openResult = async (user: ReturnType<typeof userEvent.setup>) => {
		await launchToResult(user);
		await user.click(toggle());
	};

	test("résultat sans debug : aucune section Debug", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(sampleAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
	});

	test("debug reçu mais accès sans debug (compte ordinaire) : aucune section", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
	});

	test("superuser, résultat avec debug : section en bas du panneau, modèle et prompt", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		const summary = await screen.findByText(debugTitle);
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("fournisseur-test / modele-test");
		expect(dialog.textContent).toContain("full v1");
		expect(dialog.textContent).toContain(sampleDebug.systemPrompt);
		// En bas du panneau, après le résultat IA.
		expect(dialog.lastElementChild).toBe(summary.closest("details"));
	});

	test("« Relancer sans cache » : noCache: true, résultat gardé pendant la relance, puis remplacé", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValueOnce({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugTitle);

		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		);
		expect(ai.scan).toHaveBeenCalledTimes(2);
		expect(ai.scan.mock.calls[1]?.[0]).toEqual({
			...ai.scan.mock.calls[0]?.[0],
			noCache: true,
		});
		// Pendant la relance : le résultat reste, seul le bouton indique le chargement.
		expect(screen.getByText(debugAnalysis.summary.fr)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: contentText("fr", "ai.loading") }),
		).toBeTruthy();
		expect(toggle().textContent).toContain(`${debugAnalysis.score}/100`);

		const fresh: AnalysisResult = {
			...debugAnalysis,
			score: 91,
			summary: { fr: "Nouveau verdict.", nl: "Nieuw oordeel." },
			debug: { ...sampleDebug, fromCache: false, model: "modele-2" },
		};
		await act(async () => answer({ ok: true, data: fresh }));
		expect(screen.getByText("Nouveau verdict.")).toBeTruthy();
		expect(screen.queryByText(debugAnalysis.summary.fr)).toBeNull();
		expect(screen.getByRole("dialog").textContent).toContain("modele-2");
		expect(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		).toBeTruthy();
	});

	test("relance en erreur : le verdict reste, l'erreur s'affiche dans la section Debug", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply
			.mockResolvedValueOnce({ ok: true, data: debugAnalysis })
			.mockResolvedValueOnce({ ok: false, error: { code: "rate_limited" } });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugTitle);
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		);
		expect((await screen.findByRole("alert")).textContent).toBe(
			aiErrorText("fr", "rate_limited"),
		);
		expect(screen.getByText(debugAnalysis.summary.fr)).toBeTruthy();
		expect(screen.getByText(debugTitle)).toBeTruthy();
	});

	test("debug malformé : la section Debug disparaît seule, le verdict IA reste", async () => {
		const user = userEvent.setup();
		vi.spyOn(console, "error").mockImplementation(() => {});
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		const broken = {
			...debugAnalysis,
			debug: { ...sampleDebug, messages: null },
		} as unknown as AnalysisResult;
		scanReply.mockResolvedValue({ ok: true, data: broken });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
		// Pas l'erreur générique de la section IA : seul le debug est masqué.
		expect(screen.queryByText(aiErrorText("fr", "default"))).toBeNull();
		expect(toggle().textContent).toContain(`${debugAnalysis.score}/100`);
	});

	test("« Copier » écrit le JSON du debug dans le presse-papiers", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugTitle);
		const writeText = vi.spyOn(navigator.clipboard, "writeText");
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.copy") }),
		);
		expect(writeText).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify(sampleDebug, null, 2),
		);
		expect(
			await screen.findByRole("button", {
				name: contentText("fr", "debug.copied"),
			}),
		).toBeTruthy();
	});
});

describe("RiskBadge : bandeau des annonces professionnelles", () => {
	const pro: Listing = {
		...listing,
		seller: { ...listing.seller, sellerKind: "professional" },
	};
	/** Sans abonnement, accès inconnu : le clic sur « Analyser » ouvre le panneau. */
	const openAtRest = async (
		user: ReturnType<typeof userEvent.setup>,
		locale: "fr" | "nl" = "fr",
	) => {
		ai.access.mockResolvedValue({
			ok: true,
			data: { status: "noSubscription" },
		});
		await user.click(
			screen.getByRole("button", { name: contentText(locale, "ai.launch") }),
		);
		return screen.findByRole("dialog");
	};

	test("vendeur professionnel au repos : le bandeau est en tête du panneau ouvert, sans score local", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<RiskBadge report={medium} listing={pro} locale="fr" ai={ai} />,
		);
		const dialog = await openAtRest(user);
		const note = within(dialog).getByRole("note");
		expect(note.textContent).toBe(contentText("fr", "pro.notice"));
		// En tête du panneau, juste sous son en-tête, au-dessus de tout le reste.
		expect(dialog.firstElementChild?.nextElementSibling).toBe(note);
		expect(note.className).toContain("bg-info-soft");
		expect(note.className).not.toMatch(/\bslate-/);
		expect(container.textContent).not.toContain("40/100");
		expect(container.textContent).not.toContain("Risque moyen");
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
	});

	test("en NL : texte NL du bandeau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={medium} listing={pro} locale="nl" ai={ai} />);
		const dialog = await openAtRest(user, "nl");
		expect(within(dialog).getByRole("note").textContent).toBe(
			contentText("nl", "pro.notice"),
		);
	});

	test("vendeur particulier sans détection IA : pas de bandeau", async () => {
		const user = userEvent.setup();
		const priv: Listing = {
			...listing,
			seller: { ...listing.seller, sellerKind: "private" },
		};
		render(<RiskBadge report={medium} listing={priv} locale="fr" ai={ai} />);
		await openAtRest(user);
		expect(screen.queryByRole("note")).toBeNull();
	});

	test("IA professional: true, score 75 : le bandeau et « 75/100 » sont tous deux présents", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({
			ok: true,
			data: { ...sampleAnalysis, professional: true, level: "high", score: 75 },
		});
		render(<RiskBadge report={medium} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user, 75);
		await user.click(toggle());
		const note = within(screen.getByRole("dialog")).getByRole("note");
		expect(note.textContent).toBe(contentText("fr", "pro.notice"));
		expect(toggle().textContent).toContain("Risque élevé");
		expect(screen.getByRole("dialog").textContent).toContain("75/100");
	});
});

describe("badge.css", () => {
	const css = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../components/badge.css"),
		"utf8",
	);
	const blockOf = (selector: string) =>
		css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

	test("les variables Tailwind issues de @property sont redéfinies sur :host et sur la racine", () => {
		const vars = [
			"--tw-border-style: solid",
			"--tw-outline-style: solid",
			"--tw-inset-shadow: 0 0 transparent",
			"--tw-inset-ring-shadow: 0 0 transparent",
			"--tw-ring-offset-shadow: 0 0 transparent",
			"--tw-ring-shadow: 0 0 transparent",
		];
		const shared = css.match(/:host,\s*\.radarnaque-root\s*\{([^}]*)\}/)?.[1];
		expect(shared).toBeDefined();
		for (const declaration of vars) expect(shared).toContain(declaration);
		expect(blockOf(":host")).not.toBe("");
	});

	test("les espacements sont en px", () => {
		expect(css).toMatch(/@theme\s*\{[^}]*--spacing:\s*4px/);
	});

	test("aucune couleur hexadécimale (resets --tw-* en transparent)", () => {
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	test("importe tailwindcss, puis les tokens, le thème et les animations du paquet design", () => {
		const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(imports).toEqual([
			"tailwindcss",
			"@radarnaque/design/tokens.css",
			"@radarnaque/design/theme.css",
			"@radarnaque/design/motion.css",
		]);
	});

	test("la police de l'hôte est celle des tokens (--font-sans)", () => {
		expect(blockOf(":host")).toMatch(/font-family:\s*var\(--font-sans\)/);
	});

	test("aucun composant n'utilise les rayons courts s, m, l (utilités logiques de Tailwind) : seulement sm, md, lg", () => {
		const dir = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../components",
		);
		const sources = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
		expect(sources.length).toBeGreaterThan(5);
		for (const name of sources) {
			const source = readFileSync(resolve(dir, name), "utf8");
			expect(source, name).not.toMatch(/(?<![\w-])rounded-[sml](?![\w-])/);
		}
	});

	test("plus d'animations propres à la pastille : rotation et fondu viennent de motion.css", () => {
		expect(css).not.toContain("@keyframes radarnaque-spin");
		expect(css).not.toContain("@keyframes radarnaque-fade");
		expect(css).not.toContain(".radarnaque-spin");
		expect(css).not.toContain(".radarnaque-fade");
	});

	test("animations réduites : ni rotation, ni fondu, ni points animés", () => {
		// Rotation et reflet : motion.css les coupe (testé dans le paquet design).
		// Ici, les points d'attente restent affichés, fixes.
		expect(blockOf("\\.radarnaque-status\\.is-waiting::after")).toContain(
			"animation:",
		);
		const reduced =
			css.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
		const dots =
			reduced.match(
				/\.radarnaque-status\.is-waiting::after\s*\{([^}]*)\}/,
			)?.[1] ?? "";
		expect(dots).toMatch(/content:\s*"…"/);
		expect(dots).toMatch(/animation:\s*none;/);
	});
});
