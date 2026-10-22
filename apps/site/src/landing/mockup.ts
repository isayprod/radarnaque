/**
 * Maquette du produit de la landing (spec landing §4) : une fenêtre de navigateur
 * qui montre une fiche d'annonce refaite à la main dans la mise en page d'une
 * fiche 2ememain (2dehands en néerlandais), avec la pastille Radarnaque après le
 * titre et son panneau ouvert.
 *
 * Tout est fictif : annonce, prix, vendeur, analyse. Aucun logo, aucune image ni
 * aucun fichier du site imité ; le nom du site n'apparaît qu'en texte (adresse,
 * fil d'Ariane) et la photo du produit est une illustration SVG dessinée ici.
 * Les couleurs du site imité sont des classes, définies dans le bloc de variables
 * de `mockup.css` ; celles de Radarnaque viennent des tokens.
 *
 * La maquette est une illustration (`role="img"` et sa description) : rien n'y
 * est cliquable, aucun titre n'entre dans le plan de la page.
 */
import type { Locale } from "@radarnaque/shared";
import { h, type VNode } from "../h.ts";
import { logoNode } from "../logo-node.ts";

type Severity = "danger" | "warning" | "info";

export interface MockupReason {
	severity: Severity;
	/** Libellé du badge de gravité (celui de l'extension). */
	label: string;
	text: string;
}

export interface MockupText {
	/** Description de l'illustration pour les lecteurs d'écran. */
	alt: string;
	/** Adresse affichée dans la barre de la fenêtre (texte seul). */
	address: string;
	/** Barre du haut du site imité. */
	search: string;
	messages: string;
	profile: string;
	post: string;
	otherLang: string;
	back: string;
	/** Fil d'Ariane, du site à la catégorie. */
	crumbs: readonly string[];
	/** Fiche : galerie, actions, titre, prix, mode de remise, vendeur, contact. */
	photoCount: string;
	save: string;
	share: string;
	title: string;
	price: string;
	delivery: string;
	sellerName: string;
	sellerSince: string;
	contact: string;
	descriptionTitle: string;
	description: string;
	/** Pastille et panneau : mêmes libellés que l'extension. */
	level: string;
	score: string;
	panelTitle: string;
	summary: string;
	reasonsLabel: string;
	reasons: readonly [MockupReason, MockupReason, MockupReason];
}

/** Score de l'analyse montrée (« Risque élevé »). */
const SCORE = 82;

export const MOCKUP_TEXT: Record<Locale, MockupText> = {
	fr: {
		alt: "Exemple : une annonce d'iPhone 14 Pro sur 2ememain, avec la pastille Radarnaque « Risque élevé · 82/100 » après le titre et son analyse ouverte.",
		address: "www.2ememain.be/v/telephonie-mobile/…",
		search: "Que cherchez-vous ?",
		messages: "Messages",
		profile: "Mon profil",
		post: "Publier une annonce",
		otherLang: "NL",
		back: "Retour",
		crumbs: ["2ememain", "Téléphones", "Apple iPhone"],
		photoCount: "1/4",
		save: "Enregistrer",
		share: "Partager",
		title: "iPhone 14 Pro 128 Go, comme neuf",
		price: "€ 449,00",
		delivery: "Envoi",
		sellerName: "Kevin D.",
		sellerSince: "Particulier · membre depuis 3 jours",
		contact: "Envoyer un message",
		descriptionTitle: "Description",
		description:
			"iPhone 14 Pro violet, 128 Go, comme neuf, encore sous garantie. Boîte et câble fournis. Je travaille à l'étranger : paiement uniquement par le lien que je vous envoie, envoi le jour même.",
		level: "Risque élevé",
		score: `${SCORE}/100`,
		panelTitle: "Analyse Radarnaque",
		summary:
			"Arnaque probable : prix très bas, compte tout récent et paiement demandé hors de la plateforme.",
		reasonsLabel: "Pourquoi",
		reasons: [
			{
				severity: "danger",
				label: "Grave",
				text: "Paiement exigé par un lien envoyé par le vendeur.",
			},
			{
				severity: "warning",
				label: "Attention",
				text: "Prix 45 % sous les annonces comparables.",
			},
			{
				severity: "info",
				label: "Info",
				text: "Photos trouvées sur une autre annonce.",
			},
		],
	},
	nl: {
		alt: "Voorbeeld: een advertentie voor een iPhone 14 Pro op 2dehands, met de Radarnaque-badge „Hoog risico · 82/100” na de titel en de analyse open.",
		address: "www.2dehands.be/v/telefonie/…",
		search: "Waar ben je naar op zoek?",
		messages: "Berichten",
		profile: "Mijn profiel",
		post: "Advertentie plaatsen",
		otherLang: "FR",
		back: "Terug",
		crumbs: ["2dehands", "Telefoons", "Apple iPhone"],
		photoCount: "1/4",
		save: "Bewaren",
		share: "Delen",
		title: "iPhone 14 Pro 128 GB, zo goed als nieuw",
		price: "€ 449,00",
		delivery: "Verzenden",
		sellerName: "Kevin D.",
		sellerSince: "Particulier · 3 dagen lid",
		contact: "Bericht sturen",
		descriptionTitle: "Beschrijving",
		description:
			"Paarse iPhone 14 Pro, 128 GB, zo goed als nieuw, nog onder garantie. Doos en kabel inbegrepen. Ik werk in het buitenland: betalen kan alleen via de link die ik je stuur, verzending dezelfde dag.",
		level: "Hoog risico",
		score: `${SCORE}/100`,
		panelTitle: "Radarnaque-analyse",
		summary:
			"Waarschijnlijk oplichting: heel lage prijs, gloednieuw account en betaling buiten het platform gevraagd.",
		reasonsLabel: "Waarom",
		reasons: [
			{
				severity: "danger",
				label: "Ernstig",
				text: "Betaling geëist via een link van de verkoper.",
			},
			{
				severity: "warning",
				label: "Let op",
				text: "Prijs 45 % onder vergelijkbare advertenties.",
			},
			{
				severity: "info",
				label: "Info",
				text: "Foto's gevonden in een andere advertentie.",
			},
		],
	},
};

/** Icône au trait, 16 px (loupe, cœur, partage, retour, fermer). */
function icon(d: string, size = 16): VNode {
	return h(
		"svg",
		{
			xmlns: "http://www.w3.org/2000/svg",
			viewBox: "0 0 24 24",
			width: size,
			height: size,
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
		},
		h("path", { d }),
	);
}

const ICONS = {
	search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm9 2-4.3-4.3",
	heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z",
	share: "M12 15V4m0 0L8 8m4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5",
	back: "M15 18l-6-6 6-6",
	close: "M6 6l12 12M18 6 6 18",
};

type Shot = "back" | "front" | "box" | "side";

/**
 * Photo dessinée du produit : un iPhone violet posé sur sa boîte, sur une table en
 * bois. `shot` choisit la vue (photo principale et vignettes). Couleurs par
 * classes (`mk-ph-*`, définies dans mockup.css).
 */
function photoSvg(shot: Shot): VNode {
	const svg = (...children: VNode[]) =>
		h(
			"svg",
			{
				xmlns: "http://www.w3.org/2000/svg",
				viewBox: "0 0 640 440",
				preserveAspectRatio: "xMidYMid slice",
				"aria-hidden": "true",
			},
			...children,
		);
	const table = [
		h("rect", { class: "mk-ph-wood", width: "640", height: "440" }),
		h("path", {
			class: "mk-ph-grain",
			d: "M0 40c160 18 300-14 640 10M0 130c200 22 380-20 640 6M0 250c140-16 420 30 640-4M0 360c220 20 360-18 640 12",
		}),
	];
	// La boîte blanche, de biais, et son ombre.
	const box = h(
		"g",
		{ transform: "rotate(-14 320 230)" },
		h("rect", {
			class: "mk-ph-shadow",
			x: "150",
			y: "96",
			width: "380",
			height: "280",
			rx: "12",
			transform: "translate(14 18)",
		}),
		h("rect", {
			class: "mk-ph-box-side",
			x: "150",
			y: "96",
			width: "380",
			height: "286",
			rx: "12",
		}),
		h("rect", {
			class: "mk-ph-box",
			x: "150",
			y: "90",
			width: "380",
			height: "280",
			rx: "12",
		}),
	);
	// Le dos du téléphone : coque violette, reflet, bloc photo et ses trois objectifs.
	const back = h(
		"g",
		{ transform: "rotate(-24 330 220)" },
		h("rect", {
			class: "mk-ph-shadow",
			x: "214",
			y: "62",
			width: "232",
			height: "330",
			rx: "40",
			transform: "translate(10 14)",
		}),
		h("rect", {
			class: "mk-ph-frame",
			x: "210",
			y: "58",
			width: "232",
			height: "330",
			rx: "40",
		}),
		h("rect", {
			class: "mk-ph-phone",
			x: "216",
			y: "64",
			width: "220",
			height: "318",
			rx: "35",
		}),
		h("path", {
			class: "mk-ph-sheen",
			d: "M216 200 436 96v-4a28 28 0 0 0-28-28H251a35 35 0 0 0-35 35Z",
		}),
		h("rect", {
			class: "mk-ph-bump",
			x: "232",
			y: "80",
			width: "112",
			height: "112",
			rx: "26",
		}),
		...[
			[262, 110],
			[262, 162],
			[312, 136],
		].flatMap(([cx, cy]) => [
			h("circle", { class: "mk-ph-lens", cx, cy, r: "21" }),
			h("circle", { class: "mk-ph-glass", cx, cy, r: "12" }),
			h("circle", { class: "mk-ph-glint", cx: cx - 4, cy: cy - 4, r: "3" }),
		]),
		h("circle", { class: "mk-ph-flash", cx: "318", cy: "98", r: "6" }),
		h("rect", {
			class: "mk-ph-frame",
			x: "440",
			y: "130",
			width: "5",
			height: "46",
			rx: "2.5",
		}),
	);
	// La face avant : écran noir, îlot en haut.
	const front = h(
		"g",
		{ transform: "rotate(-18 320 220)" },
		h("rect", {
			class: "mk-ph-shadow",
			x: "214",
			y: "62",
			width: "232",
			height: "330",
			rx: "40",
			transform: "translate(10 14)",
		}),
		h("rect", {
			class: "mk-ph-frame",
			x: "210",
			y: "58",
			width: "232",
			height: "330",
			rx: "40",
		}),
		h("rect", {
			class: "mk-ph-screen",
			x: "220",
			y: "68",
			width: "212",
			height: "310",
			rx: "32",
		}),
		h("path", {
			class: "mk-ph-sheen",
			d: "M220 260 432 120V100a32 32 0 0 0-32-32H252a32 32 0 0 0-32 32Z",
		}),
		h("rect", {
			class: "mk-ph-island",
			x: "290",
			y: "82",
			width: "72",
			height: "20",
			rx: "10",
		}),
	);
	if (shot === "front") return svg(...table, box, front);
	if (shot === "box")
		return svg(
			...table,
			box,
			h("rect", {
				class: "mk-ph-print",
				x: "268",
				y: "150",
				width: "104",
				height: "150",
				rx: "18",
				transform: "rotate(-14 320 230)",
			}),
		);
	if (shot === "side")
		return svg(
			...table,
			h(
				"g",
				{ transform: "rotate(-62 320 220)" },
				h("rect", {
					class: "mk-ph-frame",
					x: "210",
					y: "58",
					width: "232",
					height: "330",
					rx: "40",
				}),
				h("rect", {
					class: "mk-ph-phone",
					x: "216",
					y: "64",
					width: "220",
					height: "318",
					rx: "35",
				}),
				h("rect", {
					class: "mk-ph-bump",
					x: "232",
					y: "80",
					width: "112",
					height: "112",
					rx: "26",
				}),
			),
		);
	return svg(...table, box, back);
}

/** Pastille de résultat après le titre (BadgePill de l'extension, en statique). */
function pillNode(t: MockupText): VNode {
	return h(
		"span",
		{ class: "mk-pill" },
		h("span", { class: "mk-dot mk-dot--high", "aria-hidden": "true" }),
		h("span", {}, t.level),
		// Filet de 1 px à l'écran ; « · » lu sans CSS.
		h("span", { class: "mk-sep" }, " · "),
		h("span", { class: "mk-pill__score" }, t.score),
	);
}

/** Panneau ouvert sous la pastille (RiskBadge et AiSection de l'extension, en statique). */
function panelNode(t: MockupText): VNode {
	return h(
		"div",
		{ class: "mk-panel" },
		h(
			"div",
			{ class: "mk-panel__head" },
			logoNode({ size: 14 }),
			h("p", { class: "mk-panel__title" }, t.panelTitle),
			h("span", { class: "mk-panel__close" }, icon(ICONS.close)),
		),
		h(
			"div",
			{ class: "mk-panel__body" },
			h(
				"div",
				{ class: "mk-score-block" },
				// Verdict avant le score dans le DOM, à droite à l'écran (comme l'extension).
				h(
					"div",
					{ class: "mk-score-row" },
					h(
						"span",
						{ class: "mk-verdict" },
						h("span", { class: "mk-dot mk-dot--high", "aria-hidden": "true" }),
						h("span", {}, t.level),
					),
					h(
						"p",
						{ class: "mk-score" },
						h("span", { class: "mk-score__value" }, String(SCORE)),
						h("span", { class: "mk-score__max" }, "/100"),
					),
				),
				h(
					"div",
					{ class: "mk-bar" },
					h("div", { class: "mk-bar__fill", style: `width:${SCORE}%` }),
				),
			),
			h("p", { class: "mk-summary" }, t.summary),
			h(
				"div",
				{ class: "mk-why" },
				h("p", { class: "mk-label" }, t.reasonsLabel),
				h(
					"ul",
					{ class: "mk-reasons" },
					t.reasons.map((reason) =>
						h(
							"li",
							{},
							h(
								"span",
								{ class: `mk-sev mk-sev--${reason.severity}` },
								reason.label,
							),
							h("span", {}, reason.text),
						),
					),
				),
			),
		),
	);
}

/** Barre du haut du site imité : emplacement du logo, recherche, liens et bouton. */
function headerNode(t: MockupText): VNode {
	return h(
		"div",
		{ class: "mk-header" },
		// Pas de logo du site : une forme neutre à sa place.
		h("span", { class: "mk-logo", "aria-hidden": "true" }),
		h(
			"div",
			{ class: "mk-search" },
			h("span", { class: "mk-search__field" }, t.search),
			h("span", { class: "mk-search__button" }, icon(ICONS.search)),
		),
		h(
			"div",
			{ class: "mk-header__links" },
			h("span", { class: "mk-link" }, t.messages),
			h("span", { class: "mk-link" }, t.profile),
			h("span", { class: "mk-cta" }, t.post),
			h("span", { class: "mk-link" }, t.otherLang),
		),
	);
}

/** Maquette du produit dans la langue de la page. */
export function mockupNode(locale: Locale): VNode {
	const t = MOCKUP_TEXT[locale];
	const thumbs: Shot[] = ["back", "front", "box", "side"];
	return h(
		"div",
		{ class: "mk", role: "img", "aria-label": t.alt },
		h(
			"div",
			{ class: "mk-chrome" },
			h(
				"span",
				{ class: "mk-dots", "aria-hidden": "true" },
				h("span", {}),
				h("span", {}),
				h("span", {}),
			),
			h("span", { class: "mk-url" }, t.address),
			h("span", { class: "mk-ext" }, logoNode({ size: 14 })),
		),
		h(
			"div",
			{ class: "mk-page" },
			headerNode(t),
			h(
				"div",
				{ class: "mk-body" },
				h(
					"div",
					{ class: "mk-nav" },
					h("span", { class: "mk-back" }, icon(ICONS.back, 14), t.back),
					h(
						"ol",
						{ class: "mk-crumbs" },
						t.crumbs.map((crumb) => h("li", {}, crumb)),
					),
				),
				h(
					"div",
					{ class: "mk-grid" },
					h(
						"div",
						{ class: "mk-main" },
						h(
							"div",
							{ class: "mk-gallery" },
							h("div", { class: "mk-photo" }, photoSvg("back")),
							h("span", { class: "mk-counter" }, t.photoCount),
						),
						h(
							"div",
							{ class: "mk-thumbs" },
							thumbs.map((shot, i) =>
								h(
									"span",
									{
										class: i === 0 ? "mk-thumb mk-thumb--current" : "mk-thumb",
									},
									photoSvg(shot),
								),
							),
						),
						h("p", { class: "mk-desc-title" }, t.descriptionTitle),
						h("p", { class: "mk-desc" }, t.description),
					),
					h(
						"div",
						{ class: "mk-side" },
						h(
							"div",
							{ class: "mk-actions" },
							h("span", { class: "mk-link" }, icon(ICONS.heart), t.save),
							h("span", { class: "mk-link" }, icon(ICONS.share), t.share),
						),
						h(
							"div",
							{ class: "mk-heading" },
							h("p", { class: "mk-title" }, `${t.title} `, pillNode(t)),
							panelNode(t),
						),
						h("p", { class: "mk-price" }, t.price),
						h("span", { class: "mk-tag" }, t.delivery),
						h(
							"div",
							{ class: "mk-seller" },
							h(
								"span",
								{ class: "mk-avatar", "aria-hidden": "true" },
								t.sellerName.slice(0, 1),
							),
							h(
								"span",
								{ class: "mk-seller__text" },
								h("span", { class: "mk-seller__name" }, t.sellerName),
								" ",
								h("span", { class: "mk-seller__since" }, t.sellerSince),
							),
						),
						h("span", { class: "mk-contact" }, t.contact),
					),
				),
			),
		),
	);
}
