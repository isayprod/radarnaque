import type { Locale } from "@radarnaque/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PILL_CLASS } from "../components/BadgePill";
import { CardBadge } from "../components/CardBadge";
import {
	CARD_LEVEL_KEY,
	LEVEL_KEY,
	LEVEL_STYLE,
} from "../components/risk-styles";
import type { ScanState } from "../lib/content/ai-client";
import { addEvent, startProgress } from "../lib/content/scan-progress";
import { aiErrorText, contentText } from "../lib/content-i18n";
import { sampleAnalysis, sampleIdentification } from "./helpers";

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
	test("repos : le logo seul, pas de « R », nom card.aria (FR et NL)", () => {
		renderInLink({ status: "idle" });
		const button = screen.getByRole("button", {
			name: "Analyser cette annonce avec Radarnaque",
		});
		expect(button.getAttribute("type")).toBe("button");
		expect(button.textContent).toBe("");
		const logo = button.querySelector("svg");
		expect(logo).not.toBeNull();
		expect(logo?.getAttribute("width")).toBe("13");
		expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
		cleanup();
		renderInLink({ status: "idle" }, "nl");
		expect(
			screen.getByRole("button", {
				name: "Deze advertentie analyseren met Radarnaque",
			}),
		).toBeTruthy();
	});

	test("mini-pilule : surface de la pilule de la fiche, 22 px de haut, carrée au repos, Inter 11 px", () => {
		renderInLink({ status: "idle" });
		const classes = screen.getByRole("button").classList;
		for (const name of [
			...PILL_CLASS.split(" "),
			"h-[22px]",
			"min-w-[22px]",
			"bg-glass-host",
			"text-[11px]",
			"font-medium",
		])
			expect(classes.contains(name), name).toBe(true);
		expect(classes.contains("bg-white")).toBe(false);
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

	test("en cours : logo animé, nom card.loading", () => {
		renderInLink({ status: "loading", progress: startProgress(0) });
		const button = screen.getByRole("button", {
			name: contentText("fr", "card.loading"),
		});
		expect(button.getAttribute("aria-busy")).toBe("true");
		const logo = button.querySelector("svg");
		expect(logo?.classList.contains("rq-logo--loading")).toBe(true);
		expect(logo?.querySelector(".rq-logo-spin .rq-logo-arc")).not.toBeNull();
		expect(button.textContent).toBe(contentText("fr", "card.loading"));
		expect(contentText("fr", "card.loading")).toBe("Analyse…");
		expect(contentText("nl", "card.loading")).toBe("Analyseren…");
	});

	test("résultat high : point et « Élevé » visibles ; nom accessible « Risque élevé »", () => {
		renderInLink({
			status: "done",
			result: { ...sampleAnalysis, level: "high" },
			progress: null,
		});
		const button = screen.getByRole("button", { name: "Risque élevé" });
		expect(button.textContent).toBe("Élevé");
		expect(button.querySelector(".bg-danger")).not.toBeNull();
		expect(button.querySelector("svg")).toBeNull();
	});

	test("résultat high en NL : « Hoog » visible ; nom accessible « Hoog risico »", () => {
		renderInLink(
			{
				status: "done",
				result: { ...sampleAnalysis, level: "high" },
				progress: null,
			},
			"nl",
		);
		const button = screen.getByRole("button", { name: "Hoog risico" });
		expect(button.textContent).toBe("Hoog");
		expect(button.querySelector(".bg-danger")).not.toBeNull();
	});

	test("CARD_LEVEL_KEY : chaque niveau a son texte court, le nom garde LEVEL_KEY", () => {
		expect(CARD_LEVEL_KEY).toEqual({
			low: "card.level.low",
			medium: "card.level.medium",
			high: "card.level.high",
		});
		for (const level of ["low", "medium", "high"] as const) {
			renderInLink({
				status: "done",
				result: { ...sampleAnalysis, level },
				progress: null,
			});
			const button = screen.getByRole("button", {
				name: contentText("fr", LEVEL_KEY[level]),
			});
			expect(button.textContent).toBe(contentText("fr", CARD_LEVEL_KEY[level]));
			expect(button.querySelector(`.${LEVEL_STYLE[level].dot}`)).not.toBeNull();
			cleanup();
		}
	});

	test("infobulle : verre sombre, --r-s, 260 px, aucune classe z-[2147483647]", () => {
		renderInLink({ status: "done", result: sampleAnalysis, progress: null });
		const tooltip = screen.getByRole("tooltip", { hidden: true });
		expect(tooltip.className).not.toContain("2147483647");
		expect(tooltip.classList.contains("z-[2147483000]")).toBe(true);
		expect(tooltip.classList.contains("bg-glass-host")).toBe(true);
		expect(tooltip.classList.contains("w-[260px]")).toBe(true);
		expect(tooltip.classList.contains("rounded-sm")).toBe(true);
		expect(document.body.innerHTML).not.toContain("2147483647");
	});

	test("infobulle près du bord droit : décalée vers la gauche, la page ne défile pas", async () => {
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
			1280,
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const shift = Number.parseFloat(this.style.left || "0");
				return DOMRect.fromRect({ x: 1200 + shift, y: 0, width: 260 });
			},
		);
		const user = userEvent.setup();
		renderInLink({ status: "done", result: sampleAnalysis, progress: null });
		await user.hover(screen.getByRole("button"));
		// 1200 + 260 = 1460 : 180 px de trop, plus la marge de 8 px.
		expect(screen.getByRole("tooltip").style.left).toBe("-188px");
	});

	test("infobulle ouverte, l'icône change d'état et bouge : le décalage est recalculé", async () => {
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
			1280,
		);
		let x = 1200;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const shift = Number.parseFloat(this.style.left || "0");
				return DOMRect.fromRect({ x: x + shift, y: 0, width: 260 });
			},
		);
		const user = userEvent.setup();
		const { rerender } = renderInLink({
			status: "loading",
			progress: startProgress(0),
		});
		await user.hover(screen.getByRole("button"));
		expect(screen.getByRole("tooltip").style.left).toBe("-188px");
		// Le résultat arrive : la mini-pilule s'élargit et l'icône passe à la ligne.
		x = 100;
		rerender(
			<CardBadge
				state={{ status: "done", result: sampleAnalysis, progress: null }}
				locale="fr"
				onActivate={() => {}}
			/>,
		);
		expect(screen.getByRole("tooltip").style.left).toBe("");
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

	test("card tooltip shows the product line before the summary", () => {
		const done = (identification: typeof sampleIdentification | null) =>
			({
				status: "done",
				result: { ...sampleAnalysis, identification },
				progress: null,
			}) as ScanState;
		const tip = () => screen.getByRole("tooltip", { hidden: true });
		renderInLink(done(sampleIdentification));
		const text = tip().textContent ?? "";
		expect(text).toContain("Steam Deck OLED · Sûr");
		expect(text.indexOf("Steam Deck OLED · Sûr")).toBeLessThan(
			text.indexOf(sampleAnalysis.summary.fr),
		);
		cleanup();
		const unsure = {
			...sampleIdentification,
			status: "uncertain" as const,
			level: "uncertain" as const,
			objects: [
				{
					...(sampleIdentification
						.objects[0] as (typeof sampleIdentification)["objects"][number]),
					reference: null,
				},
			],
		};
		renderInLink(done(unsure), "nl");
		expect(tip().textContent).toContain("? · Onzeker");
		cleanup();
		// Pas d'identification, ou rien d'identifiable : pas de ligne produit.
		renderInLink(done(null));
		expect(tip().textContent).not.toContain(" · ");
		cleanup();
		renderInLink(
			done({ ...sampleIdentification, status: "none", objects: [] }),
		);
		expect(tip().textContent).toBe(sampleAnalysis.summary.fr);
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

	test("erreur : « ! » en text-danger, nom card.aria, message dans l'infobulle, un nouveau clic relance", async () => {
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
		// Le logo atténué et « ! » en --danger, plus de « R ».
		expect(button.textContent).toBe("!");
		expect(button.querySelector("svg")?.classList.contains("opacity-60")).toBe(
			true,
		);
		expect(
			[...button.querySelectorAll("span")]
				.find((el) => el.textContent === "!")
				?.classList.contains("text-danger"),
		).toBe(true);
		await user.click(button);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});
});
