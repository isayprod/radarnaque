import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useKeepInView, VIEW_MARGIN } from "../components/useKeepInView";

afterEach(cleanup);

/**
 * Couche flottante dont la position mesurée est simulée. `tick` force un
 * nouveau rendu, comme une pilule qui change de contenu (et de largeur).
 */
function Layer({ open }: { open: boolean; tick?: number }) {
	const ref = useRef<HTMLDivElement>(null);
	useKeepInView(ref, open);
	return <div ref={ref} data-testid="layer" />;
}

/** Fenêtre de `width` px ; la couche mesure `left` à `left + width` tant que `left` n'est pas posé. */
function measure(viewport: number, left: number, width: number) {
	vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
		viewport,
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			const shift = Number.parseFloat(this.style.left || "0");
			return DOMRect.fromRect({ x: left + shift, y: 0, width, height: 100 });
		},
	);
}

const layer = (container: HTMLElement) =>
	container.querySelector<HTMLElement>("[data-testid='layer']") as HTMLElement;

describe("useKeepInView", () => {
	test("couche dans la fenêtre : aucun décalage", () => {
		measure(1280, 100, 340);
		const { container } = render(<Layer open />);
		expect(layer(container).style.left).toBe("");
	});

	test("débord à droite : décalée vers la gauche jusqu'à la marge, sans défilement horizontal", () => {
		measure(1280, 1100, 340);
		const { container } = render(<Layer open />);
		// 1100 + 340 = 1440 : 160 px de trop, plus la marge.
		expect(layer(container).style.left).toBe(`-${160 + VIEW_MARGIN}px`);
	});

	test("jamais au-delà du bord gauche : le décalage s'arrête à la marge", () => {
		// 60 + 390 = 450 : 58 px de trop, mais seulement 52 px jusqu'à la marge gauche.
		measure(400, 60, 390);
		const { container } = render(<Layer open />);
		expect(layer(container).style.left).toBe(`-${60 - VIEW_MARGIN}px`);
	});

	test("fermée : rien n'est mesuré ni posé", () => {
		measure(1280, 1100, 340);
		const { container } = render(<Layer open={false} />);
		expect(layer(container).style.left).toBe("");
	});

	test("l'ancre bouge entre deux rendus (pilule élargie, passée à la ligne) : le décalage est retiré", () => {
		measure(1280, 1100, 340);
		const { container, rerender } = render(<Layer open tick={0} />);
		expect(layer(container).style.left).toBe(`-${160 + VIEW_MARGIN}px`);
		// La racine saute à gauche : sans recalcul, la couche sortirait par la gauche.
		measure(1280, 40, 340);
		rerender(<Layer open tick={1} />);
		expect(layer(container).style.left).toBe("");
	});

	test("l'ancre glisse vers la droite entre deux rendus (pilule rétrécie) : le décalage grandit", () => {
		measure(1280, 1000, 340);
		const { container, rerender } = render(<Layer open tick={0} />);
		expect(layer(container).style.left).toBe(`-${60 + VIEW_MARGIN}px`);
		measure(1280, 1100, 340);
		rerender(<Layer open tick={1} />);
		expect(layer(container).style.left).toBe(`-${160 + VIEW_MARGIN}px`);
	});

	test("refermée : le décalage posé est retiré", () => {
		measure(1280, 1100, 340);
		const { container, rerender } = render(<Layer open />);
		expect(layer(container).style.left).not.toBe("");
		rerender(<Layer open={false} />);
		expect(layer(container).style.left).toBe("");
	});

	test("fenêtre redimensionnée : le décalage est recalculé", () => {
		measure(1600, 1100, 340);
		const { container } = render(<Layer open />);
		expect(layer(container).style.left).toBe("");
		measure(1280, 1100, 340);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(layer(container).style.left).toBe(`-${160 + VIEW_MARGIN}px`);
	});
});
