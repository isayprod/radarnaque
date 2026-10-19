import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisResult } from "@radarnaque/shared";
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
	score: 80,
	level: "high",
	rulesVersion: 1,
	// Volontairement dans le désordre : le composant doit trier par gravité.
	signals: [
		{ id: "short_description", weight: 10, severity: "info" },
		{ id: "no_reviews", weight: 10, severity: "warning" },
		{ id: "new_account", weight: 25, severity: "danger" },
	],
};

const toggle = () => screen.getByRole("button", { name: /Radarnaque/ });

describe("RiskBadge", () => {
	test("niveau faible : texte, score, panneau fermé", () => {
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		expect(toggle().textContent).toContain("Risque faible");
		expect(toggle().textContent).toContain("0/100");
		expect(toggle().getAttribute("type")).toBe("button");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("fr", "badge.aria"),
		);
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("un clic ouvre le panneau avec panel.none, un second le ferme", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(dialog.textContent).toContain(contentText("fr", "panel.none"));
		expect(dialog.textContent).toContain(contentText("fr", "panel.footer"));
		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("liste les signaux par gravité : danger, warning, info", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		expect(toggle().textContent).toContain("Risque élevé");
		expect(toggle().textContent).toContain("80/100");
		await user.click(toggle());
		const items = within(screen.getByRole("dialog"))
			.getAllByRole("listitem")
			.map((li) => li.textContent);
		expect(items).toEqual([
			expect.stringContaining("Compte vendeur très récent"),
			expect.stringContaining("Aucun avis sur le vendeur"),
			expect.stringContaining("Description très courte"),
		]);
		expect(screen.queryByText(contentText("fr", "panel.none"))).toBeNull();
	});

	test("la gravité est aussi indiquée en texte, pas seulement en couleur", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		const [first] = within(screen.getByRole("dialog")).getAllByRole("listitem");
		expect(first?.textContent).toContain(contentText("fr", "severity.danger"));
	});

	test("Escape ferme le panneau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
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
		await user.click(within(container).getByRole("button"));
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
		render(<RiskBadge report={high} listing={listing} locale="nl" ai={ai} />);
		expect(toggle().textContent).toContain("Hoog risico");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("nl", "badge.aria"),
		);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("nl", "panel.title"),
		});
		expect(dialog.textContent).toContain("Zeer recent verkopersaccount");
		expect(dialog.textContent).toContain(contentText("nl", "panel.footer"));
	});

	test("ouvrir le panneau ne passe que par le client IA injecté : ni fetch, ni sendMessage direct", async () => {
		const user = userEvent.setup();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		// Analyse au clic uniquement : ouvrir le panneau ne lance aucun scan.
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("Escape ouvert est consommé : un écouteur document ultérieur ne le reçoit pas", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
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

	test("le bouton est décrit par le niveau et le score visibles", () => {
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		const ids = (toggle().getAttribute("aria-describedby") ?? "").split(" ");
		const described = ids.map((id) => document.getElementById(id)?.textContent);
		expect(described).toEqual(["Risque faible", "0/100"]);
	});
});

describe("RiskBadge : analyse IA", () => {
	/** Bouton « Lancer une analyse IA », affiché une fois l'accès chargé. */
	const findRun = () =>
		screen.findByRole("button", { name: contentText("fr", "ai.run") });

	test("le pied de panneau renvoie vers le bouton d'analyse IA", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		expect(screen.getByRole("dialog").textContent).toContain(
			"Analyse locale, sans IA. Pour une analyse IA, utilisez le bouton ci-dessus.",
		);
	});

	test("l'accès est chargé à la première ouverture, une seule fois", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		expect(ai.access).not.toHaveBeenCalled();
		await user.click(toggle());
		await findRun();
		await user.click(toggle());
		await user.click(toggle());
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(1);
	});

	test("analyse lancée, panneau fermé puis rouvert : le résultat reste, un seul scan", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
		await screen.findByText(sampleAnalysis.summary.fr);

		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(toggle());
		expect(screen.getByText(sampleAnalysis.summary.fr)).toBeTruthy();
		expect(ai.scan).toHaveBeenCalledTimes(1);
		// Le composant est resté monté : seul le panneau s'est fermé.
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
	});

	test("la requête envoyée : annonce complète, signals et rulesVersion du rapport", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
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

	test("double clic sur le bouton : une seule requête", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.dblClick(await findRun());
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("R3 : session expirée pendant un scan, l'accès relu (signedOut) ne laisse que la connexion", async () => {
		const user = userEvent.setup();
		ai.access
			.mockResolvedValueOnce({ ok: true, data: active })
			.mockResolvedValueOnce({ ok: true, data: { status: "signedOut" } });
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "session_expired" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());

		await screen.findByText(contentText("fr", "ai.loginHint"));
		expect(ai.access).toHaveBeenCalledTimes(2);
		expect(
			screen.queryByRole("button", { name: contentText("fr", "ai.run") }),
		).toBeNull();
		expect(
			screen.getAllByRole("button", { name: contentText("fr", "ai.login") }),
		).toHaveLength(1);
	});

	test("signedOut, panneau rouvert : l'accès est relu", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: { status: "signedOut" } });
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		await user.click(toggle());
		await user.click(toggle());
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(2));
	});

	test("R8 : accès en erreur, panneau rouvert : nouvel essai après 30 s seulement, puis le bouton d'analyse", async () => {
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
		await user.click(toggle());
		await screen.findByText(aiErrorText("fr", "background_unavailable"));
		await user.click(toggle());
		await user.click(toggle());
		expect(ai.access).toHaveBeenCalledTimes(1);
		clock += RECHECK_MS;
		await user.click(toggle());
		await user.click(toggle());
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(2);
	});

	test("signedOut, panneau ouvert, retour sur l'onglet (focus) : accès relu, le panneau passe à active", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValueOnce({
			ok: true,
			data: { status: "signedOut" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await screen.findByText(contentText("fr", "ai.loginHint"));

		// Connexion faite dans la popup ; la page reprend le focus.
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(2);
		expect(screen.queryByText(contentText("fr", "ai.loginHint"))).toBeNull();
	});

	test("signedOut, panneau ouvert, onglet de nouveau visible : accès relu", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValueOnce({
			ok: true,
			data: { status: "signedOut" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		const state = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("visible");
		fireEvent(document, new Event("visibilitychange"));
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(2);
		state.mockRestore();
	});

	test("accès actif : focus ou panneau rouvert ne relisent pas l'accès", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await findRun();
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await user.click(toggle());
		await user.click(toggle());
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(1);
	});

	test("panneau fermé : focus ne relit pas l'accès", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: { status: "signedOut" } });
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		await user.click(toggle());
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(ai.access).toHaveBeenCalledTimes(1);
	});

	test("photos arrivées après coup : le bouton « Analyse avec photos » apparaît", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({
			ok: true,
			data: { ...active, features: ["image_scan"] },
		});
		const view = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
		);
		await user.click(toggle());
		await findRun();
		const photos = { name: contentText("fr", "ai.runPhotos") };
		expect(screen.queryByRole("button", photos)).toBeNull();

		view.rerender(
			<RiskBadge
				report={high}
				listing={{ ...listing, images: ["https://images.example/1.jpg"] }}
				locale="fr"
				ai={ai}
			/>,
		);
		expect(screen.getByRole("button", photos)).toBeTruthy();
	});

	test("description modifiée puis clic : la requête porte la nouvelle description", async () => {
		const user = userEvent.setup();
		const view = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
		);
		await user.click(toggle());
		await findRun();
		view.rerender(
			<RiskBadge
				report={high}
				listing={{ ...listing, description: "Description complétée." }}
				locale="fr"
				ai={ai}
			/>,
		);
		await user.click(await findRun());
		expect(ai.scan.mock.calls[0]?.[0].listing.description).toBe(
			"Description complétée.",
		);
	});

	test("lien vers les formules dans la langue active", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({
			ok: true,
			data: { status: "noSubscription" },
		});
		render(<RiskBadge report={high} listing={listing} locale="nl" ai={ai} />);
		await user.click(toggle());
		const link = await screen.findByRole("link", {
			name: contentText("nl", "ai.pricing"),
		});
		expect(link.getAttribute("href")).toBe(
			"http://localhost:8080/pricing/?lang=nl",
		);
	});

	test("Se connecter sans popup disponible : texte de repli", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: { status: "signedOut" } });
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(
			await screen.findByRole("button", {
				name: contentText("fr", "ai.login"),
			}),
		);
		await screen.findByText(contentText("fr", "ai.loginFallback"));
		// Le clic dans le panneau ne l'a pas fermé.
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});

describe("RiskBadge : l'analyse IA remplace l'analyse locale", () => {
	const medium: RiskReport = {
		score: 40,
		level: "medium",
		rulesVersion: 1,
		signals: [
			{ id: "new_account", weight: 25, severity: "danger" },
			{ id: "no_reviews", weight: 15, severity: "warning" },
		],
	};
	const LOCAL_TEXTS = [
		"Compte vendeur très récent",
		"Aucun avis sur le vendeur",
		contentText("fr", "panel.footer"),
		contentText("fr", "panel.none"),
	];
	const aiHigh: AnalysisResult = {
		...sampleAnalysis,
		level: "high",
		score: 82,
		summary: { fr: "Arnaque probable.", nl: "Waarschijnlijk oplichting." },
	};
	const findRun = () =>
		screen.findByRole("button", { name: contentText("fr", "ai.run") });
	const described = () =>
		(toggle().getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent);

	/** Magasin simulé : une entrée par `site|externalId`. */
	const storeWith = (
		entries: Record<string, StoredAiResult>,
	): AiResultStore => ({
		get: async (site, id) => entries[`${site}|${id}`] ?? null,
		put: async () => {},
		prune: async () => {},
	});

	test("avant le scan : pastille « Risque moyen 40/100 », panneau avec les signaux locaux", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={medium} listing={listing} locale="fr" ai={ai} />);
		expect(toggle().textContent).toContain("Risque moyen");
		expect(toggle().textContent).toContain("40/100");
		expect(toggle().textContent).not.toContain(
			contentText("fr", "ai.badgeTag"),
		);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.textContent).toContain("Compte vendeur très récent");
		expect(dialog.textContent).toContain(contentText("fr", "panel.footer"));
		expect(screen.queryByRole("note")).toBeNull();
	});

	test("après un scan texte done (82, high) : pastille IA, panneau sans analyse locale", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(<RiskBadge report={medium} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
		await screen.findByText(aiHigh.summary.fr);

		expect(toggle().textContent).toContain("Risque élevé");
		expect(toggle().textContent).toContain("82/100");
		expect(toggle().textContent).toContain("IA");
		expect(toggle().textContent).not.toContain("40/100");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("fr", "badge.ariaAi"),
		);
		expect(described()).toEqual(["Risque élevé", "82/100"]);

		const dialog = screen.getByRole("dialog", {
			name: "Analyse IA Radarnaque",
		});
		expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(
			"Analyse IA Radarnaque",
		);
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		expect(dialog.textContent).not.toContain("Analyse locale, sans IA");
		expect(dialog.textContent).toContain("82/100");
	});

	test("en NL : mention « AI », libellé et titre NL", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(<RiskBadge report={medium} listing={listing} locale="nl" ai={ai} />);
		await user.click(toggle());
		await user.click(
			await screen.findByRole("button", { name: contentText("nl", "ai.run") }),
		);
		await screen.findByText(aiHigh.summary.nl);
		expect(toggle().textContent).toContain("Hoog risico");
		expect(toggle().textContent).toContain("AI");
		expect(toggle().getAttribute("aria-label")).toBe(
			"Radarnaque-AI-analyse openen",
		);
		expect(
			screen.getByRole("dialog", { name: "Radarnaque-AI-analyse" }),
		).toBeTruthy();
		expect(screen.getByRole("dialog").textContent).not.toContain(
			"Zeer recent verkopersaccount",
		);
	});

	test("résultat repris du magasin : même rendu, sans clic ni scan", async () => {
		const user = userEvent.setup();
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: aiHigh,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(toggle().textContent).toContain("Risque élevé");
		expect(toggle().textContent).toContain("IA");
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: "Analyse IA Radarnaque",
		});
		expect(dialog.textContent).toContain(aiHigh.summary.fr);
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("I2 : résultat repris, puis prix changé sous la même clé : pastille locale, sans « IA »", async () => {
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
		expect(toggle().textContent).toContain("40/100");
		expect(toggle().textContent).not.toContain("IA");
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("scan en cours sans résultat précédent : l'analyse locale reste affichée", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={medium} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
		expect(toggle().textContent).toContain("40/100");
		expect(toggle().textContent).not.toContain("IA");
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.textContent).toContain("Compte vendeur très récent");
		expect(dialog.textContent).toContain(contentText("fr", "ai.loading"));
	});
});

describe("RiskBadge : section Debug (superuser)", () => {
	const superuser: ContentAccess = { ...active, unlimited: true, debug: true };
	const debugTitle = contentText("fr", "debug.title");
	const findRun = () =>
		screen.findByRole("button", { name: contentText("fr", "ai.run") });

	test("résultat sans debug : aucune section Debug", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
		await screen.findByText(sampleAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
	});

	test("debug reçu mais accès sans debug (compte ordinaire) : aucune section", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
		await screen.findByText(debugAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
	});

	test("superuser, résultat avec debug : section en bas du panneau, modèle et prompt", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
		const summary = await screen.findByText(debugTitle);
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("fournisseur-test / modele-test");
		expect(dialog.textContent).toContain("text v2");
		expect(dialog.textContent).toContain(sampleDebug.systemPrompt);
		// En bas du panneau, après le résultat IA.
		expect(dialog.lastElementChild).toBe(summary.closest("details"));
	});

	test("« Relancer sans cache » : noCache: true, résultat gardé pendant la relance, puis remplacé", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValueOnce({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
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
		expect(toggle().textContent).toContain(contentText("fr", "ai.badgeTag"));

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
		await user.click(toggle());
		await user.click(await findRun());
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
		await user.click(toggle());
		await user.click(await findRun());
		await screen.findByText(debugAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
		// Pas l'erreur générique de la section IA : seul le debug est masqué.
		expect(screen.queryByText(aiErrorText("fr", "default"))).toBeNull();
		expect(toggle().textContent).toContain(contentText("fr", "ai.badgeTag"));
	});

	test("« Copier » écrit le JSON du debug dans le presse-papiers", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await user.click(await findRun());
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
	const medium: RiskReport = {
		score: 40,
		level: "medium",
		rulesVersion: 1,
		signals: [{ id: "new_account", weight: 25, severity: "danger" }],
	};
	const pro: Listing = {
		...listing,
		seller: { ...listing.seller, sellerKind: "professional" },
	};

	test("sellerKind professional sans IA : bandeau en tête du panneau, score local conservé", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={medium} listing={pro} locale="fr" ai={ai} />);
		expect(toggle().textContent).toContain("40/100");
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		const note = within(dialog).getByRole("note");
		expect(note.textContent).toBe(contentText("fr", "pro.notice"));
		// Au-dessus de tout le reste du panneau.
		expect(dialog.firstElementChild).toBe(note);
		expect(dialog.textContent).toContain("Compte vendeur très récent");
	});

	test("en NL : texte NL du bandeau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={medium} listing={pro} locale="nl" ai={ai} />);
		await user.click(toggle());
		expect(screen.getByRole("note").textContent).toBe(
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
		await user.click(toggle());
		expect(screen.queryByRole("note")).toBeNull();
	});

	test("IA professional: true, score 75 : le bandeau et « 75/100 » sont tous deux présents", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({
			ok: true,
			data: { ...sampleAnalysis, professional: true, level: "high", score: 75 },
		});
		render(<RiskBadge report={medium} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		expect(screen.queryByRole("note")).toBeNull();
		await user.click(
			await screen.findByRole("button", { name: contentText("fr", "ai.run") }),
		);
		const note = await screen.findByRole("note");
		expect(note.textContent).toBe(contentText("fr", "pro.notice"));
		expect(toggle().textContent).toContain("75/100");
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
			"--tw-inset-shadow: 0 0 #0000",
			"--tw-inset-ring-shadow: 0 0 #0000",
			"--tw-ring-offset-shadow: 0 0 #0000",
			"--tw-ring-shadow: 0 0 #0000",
		];
		const shared = css.match(/:host,\s*\.radarnaque-root\s*\{([^}]*)\}/)?.[1];
		expect(shared).toBeDefined();
		for (const declaration of vars) expect(shared).toContain(declaration);
		expect(blockOf(":host")).not.toBe("");
	});

	test("les espacements sont en px", () => {
		expect(css).toMatch(/@theme\s*\{[^}]*--spacing:\s*4px/);
	});
});
