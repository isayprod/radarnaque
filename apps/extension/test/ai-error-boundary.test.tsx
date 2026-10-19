import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AiErrorBoundary } from "../components/AiErrorBoundary";
import { RiskBadge } from "../components/RiskBadge";
import type { AiClient } from "../lib/content/ai-client";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { Listing } from "../lib/listing/types";
import type { RiskReport } from "../lib/rules/score";

// La section IA lève une erreur au rendu : la pastille doit rester utilisable.
vi.mock("../components/AiSection", () => ({
	AiSection: () => {
		throw new Error("rendu IA en échec");
	},
}));

function Throwing(): never {
	throw new Error("boom");
}

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
	seller: { name: "Vendeur" },
};

const report: RiskReport = {
	score: 25,
	level: "medium",
	rulesVersion: 1,
	signals: [{ id: "new_account", weight: 25, severity: "danger" }],
};

const ai: AiClient = {
	access: async () => ({ ok: true, data: { status: "signedOut" } }),
	scan: () => ({
		done: Promise.resolve({ ok: false, error: { code: "analysis_failed" } }),
		cancel: () => {},
	}),
	openLogin: async () => ({ ok: true, data: null }),
};

beforeEach(() => {
	// React journalise l'erreur attrapée ; la sortie du test reste lisible.
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
});

describe("AiErrorBoundary", () => {
	test("enfant en échec : message ai.error.default, en FR et en NL", () => {
		render(
			<AiErrorBoundary locale="fr">
				<Throwing />
			</AiErrorBoundary>,
		);
		expect(screen.getByText(aiErrorText("fr", "default"))).toBeTruthy();
		cleanup();
		render(
			<AiErrorBoundary locale="nl">
				<Throwing />
			</AiErrorBoundary>,
		);
		expect(screen.getByText(aiErrorText("nl", "default"))).toBeTruthy();
	});

	test("enfant sans erreur : rendu tel quel", () => {
		render(
			<AiErrorBoundary locale="fr">
				<p>section</p>
			</AiErrorBoundary>,
		);
		expect(screen.getByText("section")).toBeTruthy();
	});
});

describe("RiskBadge : section IA en échec", () => {
	test("le score local reste lisible et le panneau se ferme et se rouvre", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={report} listing={listing} locale="fr" ai={ai} />);
		const toggle = screen.getByRole("button", { name: /Radarnaque/ });
		await user.click(toggle);

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain(contentText("fr", "panel.footer"));
		expect(dialog.textContent).toContain(aiErrorText("fr", "default"));
		expect(toggle.textContent).toContain("25/100");

		await user.click(toggle);
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(toggle);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});
