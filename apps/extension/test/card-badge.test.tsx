import type { Locale } from "@radarnaque/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CardBadge } from "../components/CardBadge";
import type { ScanState } from "../lib/content/ai-client";
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

	test("pointerdown et mousedown ne remontent pas au lien", () => {
		const { reached } = renderInLink({ status: "idle" });
		const button = screen.getByRole("button");
		button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(reached).not.toHaveBeenCalled();
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
		});
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		tooltip.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(reached).not.toHaveBeenCalled();
	});

	test("loading : aria-busy et texte d'attente", () => {
		renderInLink({ status: "loading" });
		const button = screen.getByRole("button");
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.textContent).toBe(contentText("fr", "card.loading"));
		expect(contentText("fr", "card.loading")).toBe("Analyse…");
		expect(contentText("nl", "card.loading")).toBe("Analyseren…");
	});

	test("done medium : « Risque moyen », infobulle avec summary.fr au survol et au focus", async () => {
		const user = userEvent.setup();
		renderInLink({
			status: "done",
			result: { ...sampleAnalysis, level: "medium" },
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
			},
			"nl",
		);
		expect(screen.getByRole("button", { name: "Hoog risico" })).toBeTruthy();
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		expect(tooltip.textContent).toContain(sampleAnalysis.summary.nl);
		expect(tooltip.textContent).toContain(contentText("nl", "ai.partial"));
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
