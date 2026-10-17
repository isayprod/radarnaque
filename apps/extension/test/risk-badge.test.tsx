import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { AiClient } from "../lib/content/ai-client";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { Listing } from "../lib/listing/types";
import type { ContentAccess } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";
import { sampleAnalysis } from "./helpers";

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
	remaining: { text: 3, image: null, total: null },
};

/** Client IA simulé : accès actif, scans réussis. Recréé avant chaque test. */
let ai: AiClient & {
	access: ReturnType<typeof vi.fn<AiClient["access"]>>;
	scan: ReturnType<typeof vi.fn<AiClient["scan"]>>;
	openLogin: ReturnType<typeof vi.fn<AiClient["openLogin"]>>;
};
beforeEach(() => {
	ai = {
		access: vi.fn<AiClient["access"]>(async () => ({ ok: true, data: active })),
		scan: vi.fn<AiClient["scan"]>(async () => ({
			ok: true,
			data: sampleAnalysis,
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
		expect(ai.scan).toHaveBeenCalledWith({
			listing,
			signals: high.signals,
			rulesVersion: high.rulesVersion,
			scanKind: "text",
			trigger: "button",
			partial: false,
		});
	});

	test("double clic sur le bouton : une seule requête", async () => {
		const user = userEvent.setup();
		ai.scan.mockImplementation(() => new Promise(() => {}));
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
		ai.scan.mockResolvedValueOnce({
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

	test("accès en erreur, panneau rouvert : nouvel essai, puis le bouton d'analyse", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValueOnce({
			ok: false,
			error: { code: "background_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(toggle());
		await screen.findByText(aiErrorText("fr", "background_unavailable"));
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
