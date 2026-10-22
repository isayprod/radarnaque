// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { h, toDom, toHtml, type VNode } from "../src/h";

/** Relit un HTML par l'analyseur du navigateur et le resérialise (forme canonique). */
function reparse(html: string): string {
	const box = document.createElement("div");
	box.innerHTML = html;
	return box.innerHTML;
}

const PIEGE = `a < b & "c" 'd' > e`;

describe("h", () => {
	it("construit un nœud : attributs, enfants aplatis, valeurs absentes ignorées", () => {
		expect(
			h(
				"p",
				{ class: "x", hidden: true, title: undefined, "aria-busy": false },
				"un",
				[h("b", {}, "deux"), null],
				false,
				"trois",
			),
		).toEqual({
			tag: "p",
			attrs: { class: "x", hidden: true },
			children: ["un", { tag: "b", attrs: {}, children: ["deux"] }, "trois"],
		});
	});

	it("convertit les nombres en texte", () => {
		expect(h("svg", { width: 24 })).toEqual({
			tag: "svg",
			attrs: { width: "24" },
			children: [],
		});
	});

	it("refuse un nom de balise ou d'attribut qui sortirait de la balise", () => {
		expect(() => h("p onclick=x")).toThrow();
		expect(() => h("p", { 'a"b': "x" })).toThrow();
		expect(() => h("p", { "on click": "x" })).toThrow();
	});
});

describe("toHtml", () => {
	it("toHtml échappe < & \" ' dans le texte et les attributs ; toDom passe le texte en textContent", () => {
		const node = h("p", { title: PIEGE, "data-x": `"><script>` }, PIEGE);
		const html = toHtml(node);
		expect(html).toBe(
			'<p title="a &lt; b &amp; &quot;c&quot; &#39;d&#39; &gt; e"' +
				' data-x="&quot;&gt;&lt;script&gt;">' +
				"a &lt; b &amp; &quot;c&quot; &#39;d&#39; &gt; e</p>",
		);
		expect(html).not.toContain("<script");

		const el = toDom(document, node) as HTMLElement;
		expect(el.textContent).toBe(PIEGE);
		expect(el.getAttribute("title")).toBe(PIEGE);
		expect(el.querySelectorAll("*")).toHaveLength(0);
		// Le texte relu depuis le HTML échappé est identique à l'original.
		const box = document.createElement("div");
		box.innerHTML = html;
		expect(box.textContent).toBe(PIEGE);
		expect(box.querySelectorAll("script")).toHaveLength(0);
	});

	it("attribut booléen sans valeur, éléments vides sans fermeture", () => {
		expect(toHtml(h("input", { disabled: true, value: "1" }))).toBe(
			'<input disabled value="1">',
		);
		expect(toHtml(h("br"))).toBe("<br>");
		expect(toHtml("texte & co")).toBe("texte &amp; co");
	});
});

describe("toDom", () => {
	const arbre: VNode = h(
		"nav",
		{ class: "n", "aria-label": `Menu "principal"` },
		h(
			"a",
			{ href: "/?a=1&b=2", "data-lang-switch": true },
			h(
				"svg",
				{ viewBox: "0 0 32 32", "aria-hidden": "true" },
				h("g", { class: "g" }, h("circle", { cx: "16", r: "4" })),
			),
			h("span", {}, "Radar & <naque>"),
		),
		h("input", { disabled: true }),
		"fin 'texte'",
	);

	it("toHtml et toDom donnent le même arbre", () => {
		const el = toDom(document, arbre) as HTMLElement;
		expect(el.outerHTML).toBe(reparse(toHtml(arbre)));
	});

	it("crée le sous-arbre svg dans l'espace de noms SVG", () => {
		const el = toDom(document, arbre) as HTMLElement;
		const svg = el.querySelector("svg");
		const circle = el.querySelector("circle");
		expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(circle?.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg?.getAttribute("viewBox")).toBe("0 0 32 32");
		expect(el.querySelector("span")?.namespaceURI).toBe(
			"http://www.w3.org/1999/xhtml",
		);
	});

	it("un nœud texte seul devient un nœud texte", () => {
		const node = toDom(document, "<b>gras</b>");
		expect(node.nodeType).toBe(Node.TEXT_NODE);
		expect(node.textContent).toBe("<b>gras</b>");
	});
});
