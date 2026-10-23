import type { AnalysisResult } from "@radarnaque/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ScanDebug } from "../components/DebugSection";
import { RiskBadge } from "../components/RiskBadge";
import type { AiClient } from "../lib/content/ai-client";
import { contentText } from "../lib/content-i18n";
import type { Listing } from "../lib/listing/types";
import type { BgResponse, ContentAccess } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";
import { debugAnalysis, sampleDebug, sampleIdentification } from "./helpers";

/** Vrai : la section Debug échoue tant qu'une relance est en cours. */
const failure = vi.hoisted(() => ({ whileRescanning: false }));

vi.mock("../components/DebugSection", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../components/DebugSection")>();
	return {
		...actual,
		DebugSection: (props: { debug: ScanDebug; rescanning: boolean }) => {
			if (failure.whileRescanning && props.rescanning) {
				throw new Error("rendu du debug en échec");
			}
			return actual.DebugSection(
				props as Parameters<typeof actual.DebugSection>[0],
			);
		},
	};
});

afterEach(() => {
	cleanup();
	failure.whileRescanning = false;
});

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

const superuser: ContentAccess = {
	status: "active",
	features: [],
	unlimited: true,
	debug: true,
	maxImages: 4,
	remaining: { scans: 3 },
};

const low: RiskReport = {
	score: 0,
	level: "low",
	signals: [],
	rulesVersion: 1,
};

describe("RiskBadge : section Debug après une erreur de rendu", () => {
	test("la section en échec revient avec le résultat de la relance (même analyse)", async () => {
		const user = userEvent.setup();
		vi.spyOn(console, "error").mockImplementation(() => {});
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		const reply = vi
			.fn<() => Promise<BgResponse<AnalysisResult>>>()
			.mockResolvedValueOnce({ ok: true, data: debugAnalysis })
			.mockReturnValueOnce(
				new Promise((resolve) => {
					answer = resolve;
				}),
			);
		const ai = {
			access: vi.fn<AiClient["access"]>(async () => ({
				ok: true,
				data: superuser,
			})),
			scan: vi.fn<AiClient["scan"]>(() => ({
				done: reply(),
				cancel: () => {},
			})),
			identify: vi.fn<AiClient["identify"]>(() => ({
				done: Promise.resolve({ ok: true, data: sampleIdentification }),
				cancel: () => {},
			})),
			openLogin: vi.fn<AiClient["openLogin"]>(async () => ({
				ok: true,
				data: null,
			})),
		};
		const debugTitle = contentText("fr", "debug.title");
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		// Identification, puis « Analyser le risque ».
		await user.click(
			screen.getByRole("button", {
				name: contentText("fr", "identify.launch"),
			}),
		);
		await user.click(
			await screen.findByRole("button", {
				name: contentText("fr", "ai.analyzeRisk"),
			}),
		);
		// Résultat affiché dans la pilule, puis panneau ouvert.
		await vi.waitFor(() =>
			expect(
				screen.getByRole("button", { name: /Radarnaque/ }).textContent,
			).toContain(`${debugAnalysis.score}/100`),
		);
		await user.click(screen.getByRole("button", { name: /Radarnaque/ }));
		await screen.findByText(debugTitle);

		// La relance fait échouer le rendu de la section : elle disparaît seule.
		failure.whileRescanning = true;
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		);
		expect(screen.queryByText(debugTitle)).toBeNull();

		// noCache réécrit l'analyse en place : même analysisId et même inputHash,
		// seules les durées changent.
		const fresh: AnalysisResult = {
			...debugAnalysis,
			debug: {
				...sampleDebug,
				model: "modele-2",
				timingsMs: { ...sampleDebug.timingsMs, total: 1234 },
			},
		};
		await act(async () => answer({ ok: true, data: fresh }));
		expect(screen.getByText(debugTitle)).toBeTruthy();
		expect(screen.getByRole("dialog").textContent).toContain("modele-2");
	});
});
