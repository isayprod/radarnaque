/**
 * Petite représentation d'arbre partagée par le rendu au build (HTML échappé) et
 * le rendu dans la page (DOM). Aucune fonction n'insère de HTML brut : au build,
 * le texte et les attributs sont échappés ; dans la page, le texte passe par des
 * nœuds texte et les attributs par `setAttribute`, jamais par `innerHTML`.
 */

export type VNode =
	| string
	| { tag: string; attrs: Record<string, string | true>; children: VNode[] };

/** Valeur d'attribut acceptée par `h` : `false`, `null` et `undefined` l'omettent. */
export type AttrValue = string | number | boolean | null | undefined;

/** Enfant accepté par `h` : tableaux aplatis, `false`, `null` et `undefined` ignorés. */
export type Child = VNode | readonly Child[] | false | null | undefined;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Noms de balise et d'attribut admis : rien qui puisse fermer la balise. */
const NAME = /^[a-zA-Z][a-zA-Z0-9:-]*$/;

/** Éléments HTML sans contenu ni balise de fermeture. */
const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

function checkName(kind: string, name: string): void {
	if (!NAME.test(name)) throw new Error(`Nom de ${kind} refusé : ${name}`);
}

function flatten(children: readonly Child[], out: VNode[]): VNode[] {
	for (const child of children) {
		if (child === false || child === null || child === undefined) continue;
		if (Array.isArray(child)) flatten(child, out);
		else out.push(child as VNode);
	}
	return out;
}

export function h(
	tag: string,
	attrs: Record<string, AttrValue> = {},
	...children: Child[]
): VNode {
	checkName("balise", tag);
	const kept: Record<string, string | true> = {};
	for (const [name, value] of Object.entries(attrs)) {
		checkName("attribut", name);
		if (value === false || value === null || value === undefined) continue;
		kept[name] = value === true ? true : String(value);
	}
	return { tag, attrs: kept, children: flatten(children, []) };
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Échappe `&`, `<`, `>`, `"` et `'` (texte comme valeur d'attribut). */
export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** HTML du nœud, texte et attributs échappés. */
export function toHtml(node: VNode): string {
	if (typeof node === "string") return escapeHtml(node);
	const attrs = Object.entries(node.attrs)
		.map(([name, value]) =>
			value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`,
		)
		.join("");
	const open = `<${node.tag}${attrs}>`;
	if (VOID.has(node.tag)) return open;
	return `${open}${node.children.map(toHtml).join("")}</${node.tag}>`;
}

function build(doc: Document, node: VNode, namespace: string | null): Node {
	if (typeof node === "string") return doc.createTextNode(node);
	const ns = node.tag === "svg" ? SVG_NS : namespace;
	const el = ns
		? doc.createElementNS(ns, node.tag)
		: doc.createElement(node.tag);
	for (const [name, value] of Object.entries(node.attrs))
		el.setAttribute(name, value === true ? "" : value);
	for (const child of node.children) el.append(build(doc, child, ns));
	return el;
}

/** Nœud DOM du nœud : un sous-arbre `svg` est créé dans l'espace de noms SVG. */
export function toDom(doc: Document, node: VNode): Node {
	return build(doc, node, null);
}
