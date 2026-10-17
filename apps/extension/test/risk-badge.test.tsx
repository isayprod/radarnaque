import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { browser } from "wxt/browser";
import { RiskBadge } from "../components/RiskBadge";
import { contentText } from "../lib/content-i18n";
import type { RiskReport } from "../lib/rules/score";

afterEach(cleanup);

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
		render(<RiskBadge report={low} locale="fr" />);
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
		render(<RiskBadge report={low} locale="fr" />);
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
		render(<RiskBadge report={high} locale="fr" />);
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
		render(<RiskBadge report={high} locale="fr" />);
		await user.click(toggle());
		const [first] = within(screen.getByRole("dialog")).getAllByRole("listitem");
		expect(first?.textContent).toContain(contentText("fr", "severity.danger"));
	});

	test("Escape ferme le panneau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} locale="fr" />);
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
				<RiskBadge report={high} locale="fr" />
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
		const view = render(<RiskBadge report={high} locale="fr" />, { container });
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
		render(<RiskBadge report={high} locale="nl" />);
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

	test("ouvrir le panneau ne fait aucun appel réseau ni sendMessage", async () => {
		const user = userEvent.setup();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
		render(<RiskBadge report={high} locale="fr" />);
		await user.click(toggle());
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});
});
