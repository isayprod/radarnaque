import type { Locale } from "@radarnaque/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CardBadge } from "../components/CardBadge";
import type { ScanState } from "../lib/content/ai-client";
import { addEvent, startProgress } from "../lib/content/scan-progress";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { sampleAnalysis } from "./helpers";

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

/** Rend la pastille dans un lien de carte Facebook, comme sur la grille. */
function renderInLink(
	state: ScanState,
	locale: Locale = "fr",
	onActivate = vi.fn(),
) {
	const link = document.createElement("a");
	link.href = "https://www.facebook.com/marketplace/item/1/";
	const container = document.createElement("span");
	link.append(container);
	document.body.append(link);
	const reached = vi.fn();
	for (const type of [
		"click",
		"auxclick",
		"pointerdown",
		"mousedown",
		"pointerup",
		"mouseup",
		"touchend",
		"dragstart",
	]) {
		link.addEventListener(type, reached);
	}
	const utils = render(
		<CardBadge state={state} locale={locale} onActivate={onActivate} />,
		{ container },
	);
	return { ...utils, link, reached, onActivate };
}

describe("CardBadge", () => {
	test("inactif : bouton « R » avec l'aria-label FR et NL", () => {
		renderInLink({ status: "idle" });
		const button = screen.getByRole("button", {
			name: "Analyser cette annonce avec Radarnaque",
		});
		expect(button.getAttribute("type")).toBe("button");
		expect(button.textContent).toBe("R");
		cleanup();
		renderInLink({ status: "idle" }, "nl");
		expect(
			screen.getByRole("button", {
				name: "Deze advertentie analyseren met Radarnaque",
			}),
		).toBeTruthy();
	});

	test("clic dans un lien : defaultPrevented, ne remonte pas au lien", () => {
		const { reached, onActivate } = renderInLink({ status: "idle" });
		const button = screen.getByRole("button");
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		button.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(reached).not.toHaveBeenCalled();
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	test("pointerdown et mousedown : defaultPrevented (pas de glisser du lien), ne remontent pas, le bouton garde le focus", () => {
		const { reached } = renderInLink({ status: "idle" });
		const button = screen.getByRole("button");
		const pointer = new PointerEvent("pointerdown", {
			bubbles: true,
			cancelable: true,
		});
		const mouse = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});
		button.dispatchEvent(pointer);
		button.dispatchEvent(mouse);
		expect(pointer.defaultPrevented).toBe(true);
		expect(mouse.defaultPrevented).toBe(true);
		expect(reached).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(button);
	});

	test("M6 : clic du milieu (auxclick) : defaultPrevented, ne remonte pas au lien", () => {
		const { reached } = renderInLink({ status: "idle" });
		const button = screen.getByRole("button");
		const aux = new MouseEvent("auxclick", {
			bubbles: true,
			cancelable: true,
			button: 1,
		});
		button.dispatchEvent(aux);
		expect(aux.defaultPrevented).toBe(true);
		expect(reached).not.toHaveBeenCalled();
	});

	test("M6 : pointerup, mouseup et touchend ne remontent pas ; pas de glisser", () => {
		const { reached } = renderInLink({ status: "idle" });
		const button = screen.getByRole("button");
		button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
		button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		button.dispatchEvent(new Event("touchend", { bubbles: true }));
		expect(reached).not.toHaveBeenCalled();
		expect(button.getAttribute("draggable")).toBe("false");
		const drag = new Event("dragstart", { bubbles: true, cancelable: true });
		button.dispatchEvent(drag);
		expect(drag.defaultPrevented).toBe(true);
	});

	test("clic sur l'infobulle : ne navigue pas", () => {
		const { reached } = renderInLink({
			status: "done",
			result: sampleAnalysis,
			progress: null,
		});
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		tooltip.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(reached).not.toHaveBeenCalled();
	});

	test("loading : aria-busy, icône qui tourne et texte d'attente", () => {
		renderInLink({ status: "loading", progress: startProgress(0) });
		const button = screen.getByRole("button");
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.querySelector(".radarnaque-spin")).not.toBeNull();
		expect(button.textContent).toBe(contentText("fr", "card.loading"));
		expect(contentText("fr", "card.loading")).toBe("Analyse…");
		expect(contentText("nl", "card.loading")).toBe("Analyseren…");
	});

	test("done medium : « Risque moyen », infobulle avec summary.fr au survol et au focus", async () => {
		const user = userEvent.setup();
		renderInLink({
			status: "done",
			result: { ...sampleAnalysis, level: "medium" },
			progress: null,
		});
		const button = screen.getByRole("button", { name: "Risque moyen" });
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		expect(tooltip.textContent).toContain(sampleAnalysis.summary.fr);
		expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
		expect(tooltip.hidden).toBe(true);

		await user.hover(button);
		expect(screen.getByRole("tooltip").hidden).toBe(false);
		await user.unhover(button);
		expect(tooltip.hidden).toBe(true);

		button.focus();
		await vi.waitFor(() => expect(tooltip.hidden).toBe(false));
		await user.keyboard("{Escape}");
		expect(tooltip.hidden).toBe(true);
	});

	test("done partiel, en NL : summary.nl et mention de l'analyse partielle", () => {
		renderInLink(
			{
				status: "done",
				result: { ...sampleAnalysis, level: "high", partial: true },
				progress: null,
			},
			"nl",
		);
		expect(screen.getByRole("button", { name: "Hoog risico" })).toBeTruthy();
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		expect(tooltip.textContent).toContain(sampleAnalysis.summary.nl);
		expect(tooltip.textContent).toContain(contentText("nl", "ai.partial"));
	});

	test("done professionnel : pro.notice sous le résumé, en FR et en NL", () => {
		const professional = { ...sampleAnalysis, professional: true };
		renderInLink({ status: "done", result: professional, progress: null });
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		const text = tooltip.textContent ?? "";
		const notice = contentText("fr", "pro.notice");
		expect(text).toContain(sampleAnalysis.summary.fr);
		expect(text).toContain(notice);
		expect(text.indexOf(notice)).toBeGreaterThan(
			text.indexOf(sampleAnalysis.summary.fr),
		);
		cleanup();
		renderInLink(
			{ status: "done", result: professional, progress: null },
			"nl",
		);
		expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain(
			contentText("nl", "pro.notice"),
		);
	});

	test("done non professionnel : pas de pro.notice", () => {
		renderInLink({ status: "done", result: sampleAnalysis, progress: null });
		expect(
			screen.getByRole("tooltip", { hidden: true }).textContent,
		).not.toContain(contentText("fr", "pro.notice"));
	});

	test("tooltip shows live line : la ligne d'état suit le dernier événement", async () => {
		const user = userEvent.setup();
		const start = startProgress(0);
		const searching = addEvent(
			start,
			{ type: "search", id: 1, query: "iPhone 18 Pro prix", aspect: "price" },
			1_000,
		);
		const { rerender, onActivate } = renderInLink({
			status: "loading",
			progress: start,
		});
		const button = screen.getByRole("button");
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		expect(tooltip.textContent).toBe("Démarrage de l'analyse");
		expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
		await user.hover(button);
		expect(tooltip.hidden).toBe(false);

		rerender(
			<CardBadge
				state={{ status: "loading", progress: searching }}
				locale="fr"
				onActivate={onActivate}
			/>,
		);
		expect(screen.getByRole("tooltip").textContent).toBe(
			"Recherche web (prix du marché) : “iPhone 18 Pro prix”",
		);
		// Texte du modèle : rendu en texte, jamais en HTML.
		rerender(
			<CardBadge
				state={{
					status: "loading",
					progress: addEvent(
						searching,
						{ type: "thinking", part: 1, text: "<img src=x onerror=alert(1)>" },
						2_000,
					),
				}}
				locale="fr"
				onActivate={onActivate}
			/>,
		);
		expect(document.querySelector("img")).toBeNull();
		expect(screen.getByRole("tooltip").textContent).toBe(
			"<img src=x onerror=alert(1)>",
		);
	});

	test("error : message dans l'infobulle, un nouveau clic relance", async () => {
		const user = userEvent.setup();
		const { onActivate } = renderInLink({
			status: "error",
			code: "quota_exhausted",
		});
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		expect(tooltip.textContent).toBe(aiErrorText("fr", "quota_exhausted"));
		const button = screen.getByRole("button", {
			name: contentText("fr", "card.aria"),
		});
		expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
		await user.click(button);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});
});
