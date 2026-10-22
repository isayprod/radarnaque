import type { ScanProgressEvent } from "@radarnaque/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ScanProgressView } from "../components/ScanProgressView";
import {
	addEvent,
	type ScanProgress,
	startProgress,
} from "../lib/content/scan-progress";
import { contentText } from "../lib/content-i18n";

afterEach(cleanup);

const START = 1_000_000;

/** Progression construite à partir d'événements reçus à `START + ms`. */
function progressOf(
	...steps: Array<[ms: number, event: ScanProgressEvent]>
): ScanProgress {
	return steps.reduce(
		(p, [ms, event]) => addEvent(p, event, START + ms),
		startProgress(START),
	);
}

const sample = progressOf(
	[0, { type: "stage", stage: "photos", count: 3 }],
	[1_200, { type: "stage", stage: "analyzing", count: 3 }],
	[
		2_000,
		{ type: "search", id: 1, query: "iPhone 18 Pro prix", aspect: "price" },
	],
	[
		3_400,
		{
			type: "search_done",
			id: 1,
			ok: true,
			count: 5,
			domains: ["apple.com", "tweakers.net"],
		},
	],
	[
		5_000,
		{
			type: "thinking",
			part: 1,
			text: "**Prix cohérent**\nLe prix suit le marché.",
		},
	],
	[7_600, { type: "stage", stage: "writing" }],
);

const items = () =>
	screen.getAllByRole("listitem").map((li) => li.textContent ?? "");

describe("ScanProgressView", () => {
	test("les étapes dans l'ordre, avec leur temps écoulé", () => {
		render(<ScanProgressView progress={sample} locale="fr" live />);
		const lines = items();
		expect(lines).toHaveLength(6);
		expect(lines[0]).toContain("0 s");
		expect(lines[0]).toContain("Téléchargement de 3 photos");
		expect(lines[1]).toContain("1 s");
		expect(lines[1]).toContain("Examine l'annonce et 3 photos");
		expect(lines[2]).toContain("2 s");
		expect(lines[2]).toContain(
			"Recherche web (prix du marché) : “iPhone 18 Pro prix”",
		);
		expect(lines[3]).toContain("3 s");
		expect(lines[3]).toContain("5 résultats : apple.com, tweakers.net");
		expect(lines[4]).toContain("5 s");
		expect(lines[4]).toContain("Prix cohérent");
		// Le résumé de réflexion entier, sans les marqueurs `**`.
		expect(lines[4]).toContain("Le prix suit le marché.");
		expect(lines[4]).not.toContain("**");
		expect(lines[5]).toContain("8 s");
		expect(lines[5]).toContain("Rédige le verdict");
	});

	test("le corps d'une réflexion ne répète pas le titre affiché", () => {
		const count = (text: string, part: string) => text.split(part).length - 1;
		const p = progressOf(
			[
				0,
				{
					type: "thinking",
					part: 1,
					text: "**Prix cohérent**\n\nLe prix suit le marché.",
				},
			],
			[
				1_000,
				{
					type: "thinking",
					part: 2,
					text: "Je regarde le prix. Il semble bas.",
				},
			],
			[2_000, { type: "thinking", part: 3, text: "Une seule phrase." }],
		);
		render(<ScanProgressView progress={p} locale="fr" live />);
		const [titled, plain, single] = items();
		expect(count(titled ?? "", "Prix cohérent")).toBe(1);
		expect(titled).toContain("Le prix suit le marché.");
		// Sans titre en gras, la dernière phrase sert de ligne : le corps garde le reste.
		expect(count(plain ?? "", "Il semble bas.")).toBe(1);
		expect(plain).toContain("Je regarde le prix.");
		expect(count(single ?? "", "Une seule phrase.")).toBe(1);
	});

	test("en direct : la liste seule ; après l'analyse : repliée sous « Comment l'IA a analysé »", () => {
		const { container, rerender } = render(
			<ScanProgressView progress={sample} locale="fr" live />,
		);
		expect(container.querySelector("details")).toBeNull();
		rerender(<ScanProgressView progress={sample} locale="fr" live={false} />);
		const details = container.querySelector("details");
		expect(details?.open).toBe(false);
		expect(details?.querySelector("summary")?.textContent).toBe(
			"Comment l'IA a analysé",
		);
		expect(details?.querySelectorAll("li")).toHaveLength(6);
	});

	test("en NL", () => {
		render(<ScanProgressView progress={sample} locale="nl" live={false} />);
		expect(screen.getByText(contentText("nl", "ai.howAnalyzed"))).toBeTruthy();
		expect(items()[2]).toContain(
			"Webzoekopdracht (marktprijs): “iPhone 18 Pro prix”",
		);
	});

	test("résultat en cache sans déroulé : les recherches gardées en base", () => {
		render(
			<ScanProgressView
				progress={null}
				locale="fr"
				live={false}
				webSearches={[
					{ query: "iPhone 18 Pro prix", aspect: "price" },
					{ query: "arnaque iPhone", aspect: "scam" },
				]}
			/>,
		);
		expect(items()).toEqual([
			"Recherche web (prix du marché) : “iPhone 18 Pro prix”",
			"Recherche web (arnaque connue) : “arnaque iPhone”",
		]);
	});

	test("déroulé qui a déjà ses recherches : celles gardées en base ne sont pas répétées", () => {
		render(
			<ScanProgressView
				progress={sample}
				locale="fr"
				live={false}
				webSearches={[{ query: "iPhone 18 Pro prix", aspect: "price" }]}
			/>,
		);
		expect(items()).toHaveLength(6);
	});

	test("ni déroulé ni recherche : rien", () => {
		const { container } = render(
			<ScanProgressView progress={null} locale="fr" live={false} />,
		);
		expect(container.innerHTML).toBe("");
	});

	test("texte du modèle rendu en texte, jamais en HTML", () => {
		const p = progressOf([
			0,
			{ type: "thinking", part: 1, text: "<img src=x onerror=alert(1)>" },
		]);
		const { container } = render(
			<ScanProgressView progress={p} locale="fr" live />,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
	});

	test("contraste : temps écoulé et corps de la réflexion en text-text-2, jamais text-text-3", () => {
		const { container } = render(
			<ScanProgressView progress={sample} locale="fr" live />,
		);
		const time = screen.getAllByText("0 s")[0];
		expect(time?.classList.contains("text-text-2")).toBe(true);
		expect(screen.getByText("Le prix suit le marché.").className).toContain(
			"text-text-2",
		);
		expect(container.innerHTML).not.toContain("text-text-3");
	});

	test("tokens du design : plus aucune couleur slate ; replié, le déroulé se range à droite", () => {
		const { container } = render(
			<ScanProgressView progress={sample} locale="fr" live={false} />,
		);
		expect(container.innerHTML).not.toMatch(/\bslate-/);
		const details = container.querySelector("details");
		expect(details?.className).toContain("ml-auto");
		expect(details?.querySelector("summary")?.className).toContain(
			"text-text-2",
		);
	});
});
