import { LOGO } from "@radarnaque/design/logo";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LiveLine } from "../components/LiveStatus";
import { Logo } from "../components/Logo";

afterEach(cleanup);

describe("Logo", () => {
	test("au repos : SVG en ligne de LOGO, décoratif, sans classe d'animation", () => {
		const { container } = render(<Logo size={16} />);
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("viewBox")).toBe(LOGO.viewBox);
		expect(svg?.getAttribute("width")).toBe("16");
		expect(svg?.getAttribute("height")).toBe("16");
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		expect(svg?.classList.contains("rq-logo--loading")).toBe(false);
		expect(svg?.querySelector(".rq-logo-spin")).toBeNull();
		expect(svg?.querySelector(".rq-logo-arc")).toBeNull();
		// Jamais de `<use>` : une animation CSS n'atteindrait pas son contenu.
		expect(svg?.querySelector("use")).toBeNull();

		const [arc, dot] = Array.from(svg?.querySelectorAll("circle") ?? []);
		expect(arc?.getAttribute("r")).toBe(String(LOGO.arcRadius));
		expect(arc?.getAttribute("fill")).toBe("none");
		expect(arc?.getAttribute("stroke")).toBe("currentColor");
		expect(arc?.getAttribute("stroke-width")).toBe(String(LOGO.strokeWidth));
		expect(arc?.getAttribute("stroke-linecap")).toBe("round");
		expect(arc?.getAttribute("pathLength")).toBe("360");
		expect(arc?.getAttribute("stroke-dasharray")).toBe(LOGO.dashArray);
		expect(arc?.getAttribute("stroke-dashoffset")).toBe(
			String(LOGO.dashOffset),
		);
		expect(dot?.getAttribute("r")).toBe(String(LOGO.dotRadius));
		expect(dot?.getAttribute("fill")).toBe("currentColor");
		for (const circle of [arc, dot]) {
			expect(circle?.getAttribute("cx")).toBe(String(LOGO.center));
			expect(circle?.getAttribute("cy")).toBe(String(LOGO.center));
		}
	});

	test("animé : rq-logo--loading sur le SVG, l'arc seul dans le groupe tournant, aucun attribut transform", () => {
		const { container } = render(
			<Logo size={13} animated className="shrink-0" />,
		);
		const svg = container.querySelector("svg");
		expect(svg?.classList.contains("rq-logo--loading")).toBe(true);
		expect(svg?.classList.contains("shrink-0")).toBe(true);
		const spin = svg?.querySelector("g.rq-logo-spin");
		expect(spin).not.toBeNull();
		expect(spin?.querySelectorAll("circle")).toHaveLength(1);
		expect(
			spin?.querySelector("circle")?.classList.contains("rq-logo-arc"),
		).toBe(true);
		// Le point reste hors du groupe tournant.
		const dot = svg?.querySelector(":scope > circle");
		expect(dot?.getAttribute("r")).toBe(String(LOGO.dotRadius));
		expect(svg?.querySelector("[transform]")).toBeNull();
	});
});

describe("LiveLine", () => {
	test("le texte porte le reflet (rq-shimmer), tronqué ; masqué aux lecteurs d'écran", () => {
		const { container } = render(
			<LiveLine text="Rédige le verdict" waiting={false} />,
		);
		const line = container.querySelector(".radarnaque-status");
		expect(line?.getAttribute("aria-hidden")).toBe("true");
		expect(line?.classList.contains("min-w-0")).toBe(true);
		expect(line?.classList.contains("is-waiting")).toBe(false);
		const text = line?.querySelector(".rq-shimmer");
		expect(text?.textContent).toBe("Rédige le verdict");
		expect(text?.classList.contains("truncate")).toBe(true);
		expect(text?.classList.contains("min-w-0")).toBe(true);
		// L'ancien fondu est remplacé par le reflet de motion.css.
		expect(container.querySelector(".radarnaque-fade")).toBeNull();
	});

	test("attente : la classe is-waiting sur la ligne (points de suspension)", () => {
		const { container } = render(<LiveLine text="Recherche" waiting />);
		expect(
			container
				.querySelector(".radarnaque-status")
				?.classList.contains("is-waiting"),
		).toBe(true);
	});
});
