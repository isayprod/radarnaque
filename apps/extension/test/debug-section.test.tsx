import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DebugSection } from "../components/DebugSection";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { sampleDebug } from "./helpers";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

/** Presse-papiers simulé, posé sur `navigator` le temps du test. */
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
beforeEach(() => {
	writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
});

function renderSection(
	overrides: Partial<Parameters<typeof DebugSection>[0]> = {},
) {
	const onRescan = vi.fn();
	const view = render(
		<DebugSection
			locale="fr"
			debug={sampleDebug}
			rescanning={false}
			onRescan={onRescan}
			{...overrides}
		/>,
	);
	return { ...view, onRescan };
}

/** Valeur affichée en face d'un libellé (`<dt>` puis `<dd>`). */
function shownValue(container: HTMLElement, label: string) {
	const dt = [...container.querySelectorAll("dt")].find(
		(el) => el.textContent === label,
	);
	return dt?.nextElementSibling as HTMLElement | null;
}

describe("DebugSection", () => {
	test("section repliable, titre « Debug (superuser) »", () => {
		const { container } = renderSection();
		const details = container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details?.querySelector(":scope > summary")?.textContent).toBe(
			"Debug (superuser)",
		);
	});

	test("fournisseur, modèle, prompt, appel LLM, cache, tokens et coût", () => {
		const { container } = renderSection();
		expect(shownValue(container, "provider / model")?.textContent).toBe(
			"fournisseur-test / modele-test",
		);
		expect(shownValue(container, "prompt")?.textContent).toBe("full v1");
		expect(shownValue(container, "llmCalled")?.textContent).toBe("true");
		expect(shownValue(container, "fromCache")?.textContent).toBe("false");
		expect(shownValue(container, "tokens in / out")?.textContent).toBe(
			"100 / 20",
		);
		// 1234 micro-dollars : 6 décimales.
		expect(shownValue(container, "cost")?.textContent).toBe("$0.001234");
		expect(shownValue(container, "timings")?.textContent).toBe(
			"total 950 ms · llm 900 ms · images — · search —",
		);
		expect(shownValue(container, "rounds")?.textContent).toBe("1");
	});

	test("tours, recherches et réflexion : en texte seul", () => {
		const { container } = renderSection({
			debug: {
				...sampleDebug,
				rounds: 3,
				timingsMs: { ...sampleDebug.timingsMs, search: 1500 },
				searches: [
					{
						query: "iPhone 18 Pro prix",
						aspect: "price",
						ok: true,
						output: "1. <b>Apple</b> — apple.com",
						ms: 812,
					},
					{
						query: "arnaque iPhone",
						aspect: "scam",
						ok: false,
						output: "Recherche indisponible",
						ms: 8000,
					},
				],
				reasoning: "**Prix**\nLe prix <i>suit</i> le marché.",
			},
		});
		expect(shownValue(container, "rounds")?.textContent).toBe("3");
		expect(shownValue(container, "timings")?.textContent).toBe(
			"total 950 ms · llm 900 ms · images — · search 1500 ms",
		);
		const block = (title: string) =>
			[...container.querySelectorAll("details details")].find(
				(d) => d.querySelector("summary")?.textContent === title,
			);
		const searches = block("Recherches web")?.querySelector("pre");
		expect(searches?.textContent).toBe(
			"[1] price · ok · 812 ms\nquery: iPhone 18 Pro prix\n1. <b>Apple</b> — apple.com\n\n[2] scam · failed · 8000 ms\nquery: arnaque iPhone\nRecherche indisponible",
		);
		expect(searches?.querySelector("b")).toBeNull();
		const reasoning = block("Réflexion")?.querySelector("pre");
		expect(reasoning?.textContent).toBe(
			"**Prix**\nLe prix <i>suit</i> le marché.",
		);
		expect(reasoning?.querySelector("i")).toBeNull();
	});

	test("sans recherche ni réflexion : un tiret", () => {
		const { container } = renderSection();
		for (const title of ["Recherches web", "Réflexion"]) {
			const block = [...container.querySelectorAll("details details")].find(
				(d) => d.querySelector("summary")?.textContent === title,
			);
			expect(block?.querySelector("pre")?.textContent).toBe("—");
		}
	});

	test("empreintes raccourcies à 12 caractères, la valeur complète en title", () => {
		const { container } = renderSection();
		const input = shownValue(container, "inputHash");
		expect(input?.textContent).toBe(sampleDebug.inputHash.slice(0, 12));
		expect(input?.getAttribute("title")).toBe(sampleDebug.inputHash);
		const content = shownValue(container, "contentHash");
		expect(content?.textContent).toBe(sampleDebug.contentHash.slice(0, 12));
		expect(content?.getAttribute("title")).toBe(sampleDebug.contentHash);
	});

	test("prompt système, messages et réponse brute en <pre> repliables, en texte seul", () => {
		const { container } = renderSection();
		const block = (title: string) =>
			[...container.querySelectorAll("details details")].find(
				(d) => d.querySelector("summary")?.textContent === title,
			);
		expect(block("Prompt système")?.querySelector("pre")?.textContent).toBe(
			"Tu analyses une annonce.",
		);
		const messages = block("Messages envoyés")?.querySelector("pre");
		expect(messages?.textContent).toBe(
			"user:\nAnnonce : Vélo <b>gras</b>\n\nuser:\n[image 1 : 2048 octets]",
		);
		// Jamais interprété comme du HTML.
		expect(messages?.querySelector("b")).toBeNull();
		expect(block("Réponse brute")?.querySelector("pre")?.textContent).toBe(
			'{"score": 55}',
		);
	});

	test("réponse brute absente (LLM non appelé) : un tiret", () => {
		const { container } = renderSection({
			debug: { ...sampleDebug, rawResponse: null, llmCalled: false },
		});
		const raw = [...container.querySelectorAll("details details")].find(
			(d) => d.querySelector("summary")?.textContent === "Réponse brute",
		);
		expect(raw?.querySelector("pre")?.textContent).toBe("—");
	});

	test("« Relancer sans cache » appelle onRescan ; pendant la relance, « Analyse en cours… » désactivé", () => {
		const { onRescan, rerender } = renderSection();
		fireEvent.click(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		);
		expect(onRescan).toHaveBeenCalledTimes(1);

		rerender(
			<DebugSection
				locale="fr"
				debug={sampleDebug}
				rescanning={true}
				onRescan={onRescan}
			/>,
		);
		const busy = screen.getByRole("button", {
			name: contentText("fr", "ai.loading"),
		});
		expect(busy).toHaveProperty("disabled", true);
		expect(busy.getAttribute("aria-busy")).toBe("true");
	});

	test("« Copier » écrit le JSON du debug, affiche « Copié » 2 s", async () => {
		vi.useFakeTimers();
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Copier" }));
		expect(writeText).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify(sampleDebug, null, 2),
		);
		await act(async () => {});
		expect(screen.getByRole("button", { name: "Copié" })).toBeTruthy();
		act(() => vi.advanceTimersByTime(2000));
		expect(screen.getByRole("button", { name: "Copier" })).toBeTruthy();
	});

	test("échec du presse-papiers (refus ou absent) : ignoré, le bouton reste « Copier »", async () => {
		writeText.mockRejectedValue(new Error("refusé"));
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Copier" }));
		await act(async () => {});
		expect(screen.getByRole("button", { name: "Copier" })).toBeTruthy();

		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});
		expect(() =>
			fireEvent.click(screen.getByRole("button", { name: "Copier" })),
		).not.toThrow();
		await act(async () => {});
	});

	test("erreur de la dernière relance : une ligne avec le texte de l'erreur", () => {
		renderSection({ error: "rate_limited" });
		expect(screen.getByRole("alert").textContent).toBe(
			aiErrorText("fr", "rate_limited"),
		);
	});

	test("sans erreur : aucune ligne d'alerte", () => {
		renderSection();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("démontée avant la fin de la copie : ni « Copié », ni minuterie", async () => {
		vi.useFakeTimers();
		let done!: () => void;
		writeText.mockReturnValue(
			new Promise<void>((resolve) => {
				done = resolve;
			}),
		);
		const { unmount } = renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Copier" }));
		unmount();
		await act(async () => done());
		expect(vi.getTimerCount()).toBe(0);
	});

	test("textes en néerlandais", () => {
		const { container } = renderSection({ locale: "nl" });
		expect(screen.getByRole("button", { name: "Kopiëren" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Opnieuw zonder cache" }),
		).toBeTruthy();
		const titles = [
			...container.querySelectorAll("details details summary"),
		].map((s) => s.textContent);
		expect(titles).toEqual([
			"Systeemprompt",
			"Verzonden berichten",
			"Webzoekopdrachten",
			"Redenering",
			"Ruw antwoord",
		]);
	});
});
