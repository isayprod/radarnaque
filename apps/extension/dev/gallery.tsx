/**
 * Galerie visuelle de la pastille (`pnpm --filter extension gallery`, port 3101).
 *
 * Chaque état est monté dans son propre shadow root, avec le CSS de badge.css
 * passé par `shadowCssOf`, comme le fait le content script ; la page autour est
 * une fiche fictive sur fond blanc. Les clients IA et d'accès sont des doublures
 * locales (aucun réseau). Certains états demandent des clics (lancer
 * l'analyse, ouvrir le panneau) : un petit scénario les joue après le montage.
 *
 * Les polices viennent de `fonts.css`, chargé par le document : un `@font-face`
 * du document s'applique aussi dans les shadow roots (le content script passe,
 * lui, par `loadFonts` et `document.fonts`).
 */
import "@radarnaque/design/fonts.css";
import type {
	AnalysisResult,
	IdentificationResult,
	Locale,
	ScanProgressEvent,
} from "@radarnaque/shared";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import badgeCss from "../components/badge.css?inline";
import { CardBadge } from "../components/CardBadge";
import { RiskBadge } from "../components/RiskBadge";
import {
	type AccessReading,
	createAccessCache,
} from "../lib/content/access-policy";
import type { AiClient, ScanState } from "../lib/content/ai-client";
import {
	type AiResultStore,
	listingFingerprint,
} from "../lib/content/ai-results";
import { addEvent, startProgress } from "../lib/content/scan-progress";
import { shadowCssOf } from "../lib/content/ui-context";
import type { Listing } from "../lib/listing/types";
import type { BgResponse, ContentAccess } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";

const SHADOW_CSS = shadowCssOf(badgeCss);

// --- Données fictives ------------------------------------------------------

const TITLES: Record<Locale, string> = {
	fr: "Vélo de ville fictif, cadre 54 cm, très bon état",
	nl: "Fictieve stadsfiets, frame 54 cm, zeer goede staat",
};

/** Annonce fictive : seul l'identifiant change d'un état à l'autre. */
function listingOf(id: string, locale: Locale, professional = false): Listing {
	const site = locale === "fr" ? "2ememain.be" : "2dehands.be";
	return {
		site,
		externalId: `galerie-${id}`,
		url: `https://www.${site}/v/galerie/galerie-${id}`,
		title: TITLES[locale],
		description: "Annonce fictive de la galerie.",
		price: { amountCents: 18000, currency: "EUR" },
		priceType: "fixed",
		location: { city: "Namur" },
		images: [],
		seller: {
			name: "Vendeur fictif",
			reviewCount: 2,
			sellerKind: professional ? "professional" : "private",
		},
	};
}

/** Analyse locale : jamais affichée, envoyée avec la demande. */
const REPORT: RiskReport = {
	score: 0,
	level: "low",
	signals: [],
	rulesVersion: 1,
};

const active = (scans: number): ContentAccess => ({
	status: "active",
	features: ["card_icons"],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans },
});

/** Requête de recherche de 200 caractères : la ligne d'état la plus longue. */
const LONG_QUERY =
	"vélo de ville cadre 54 cm très bon état prix habituel occasion belgique comparaison annonces similaires arnaque paiement à l'avance livraison par coursier vendeur à l'étranger remboursement garanti";

const SEARCHES: ScanProgressEvent[] = [
	{ type: "stage", stage: "photos", count: 3 },
	{ type: "stage", stage: "analyzing", count: 3 },
	{ type: "search", id: 1, query: "vélo de ville 54 cm prix", aspect: "price" },
	{
		type: "search_done",
		id: 1,
		ok: true,
		count: 8,
		domains: ["exemple.test", "comparateur.test"],
	},
	{ type: "stage", stage: "writing" },
];

const RESULTS: Record<"low" | "medium" | "high", AnalysisResult> = {
	low: {
		analysisId: 1,
		analyzedAt: new Date().toISOString(),
		fromCache: false,
		level: "low",
		partial: false,
		professional: false,
		score: 12,
		summary: {
			fr: "Rien d'inhabituel dans cette annonce.",
			nl: "Niets ongewoons in deze advertentie.",
		},
		advice: {
			fr: "Voyez le vélo avant de payer.",
			nl: "Bekijk de fiets vóór je betaalt.",
		},
		reasons: [],
		remaining: { scans: 2 },
		imagesAnalyzed: 3,
		webSearches: [],
	},
	medium: {
		analysisId: 2,
		analyzedAt: new Date().toISOString(),
		fromCache: true,
		level: "medium",
		partial: false,
		professional: true,
		score: 48,
		summary: {
			fr: "Prix un peu bas pour ce modèle, le reste est cohérent.",
			nl: "Prijs wat laag voor dit model, de rest klopt.",
		},
		advice: {
			fr: "Demandez la facture d'achat.",
			nl: "Vraag naar de aankoopfactuur.",
		},
		reasons: [
			{
				severity: "warning",
				text: {
					fr: "Prix 30 % sous les annonces comparables.",
					nl: "Prijs 30 % onder vergelijkbare advertenties.",
				},
			},
			{
				severity: "info",
				text: {
					fr: "Vendeur professionnel déclaré.",
					nl: "Aangegeven professionele verkoper.",
				},
			},
		],
		remaining: { scans: 2 },
		imagesAnalyzed: 0,
		webSearches: [],
	},
	high: {
		analysisId: 3,
		analyzedAt: new Date().toISOString(),
		fromCache: false,
		level: "high",
		partial: false,
		professional: false,
		score: 86,
		summary: {
			fr: "Arnaque probable : paiement à l'avance et livraison par coursier.",
			nl: "Waarschijnlijk oplichting: vooruitbetaling en levering per koerier.",
		},
		advice: {
			fr: "Ne payez rien avant d'avoir vu le vélo.",
			nl: "Betaal niets voor je de fiets gezien hebt.",
		},
		reasons: [
			{
				severity: "danger",
				text: {
					fr: "Le vendeur demande un paiement avant la remise.",
					nl: "De verkoper vraagt betaling voor de overhandiging.",
				},
			},
			{
				severity: "warning",
				text: {
					fr: "Prix 45 % sous les annonces comparables.",
					nl: "Prijs 45 % onder vergelijkbare advertenties.",
				},
			},
			{
				severity: "info",
				text: {
					fr: "Photos reprises d'une autre annonce.",
					nl: "Foto's overgenomen van een andere advertentie.",
				},
			},
		],
		remaining: { scans: 2 },
		imagesAnalyzed: 3,
		webSearches: [{ query: "vélo de ville 54 cm prix", aspect: "price" }],
	},
};

// --- Doublures ---------------------------------------------------------------

type Outcome = BgResponse<AnalysisResult>;

/** Ce que fait le client IA simulé d'un état. */
interface ClientPlan {
	access: AccessReading;
	/** Événements envoyés pendant l'analyse, un toutes les 60 ms. */
	events?: ScanProgressEvent[];
	/** Issue de l'analyse ; sans issue, l'analyse ne finit jamais. */
	outcome?: Outcome;
	/** La popup de connexion ne s'ouvre pas : le panneau montre le repli. */
	loginFails?: boolean;
}

function fakeClient(plan: ClientPlan): AiClient {
	return {
		access: async () =>
			"error" in plan.access
				? { ok: false, error: { code: plan.access.error } }
				: { ok: true, data: plan.access },
		scan(_req, onEvent) {
			const timers: number[] = [];
			let settle!: (response: Outcome) => void;
			const done = new Promise<Outcome>((resolve) => {
				settle = resolve;
			});
			const events = plan.events ?? [];
			events.forEach((event, index) => {
				timers.push(window.setTimeout(() => onEvent(event), 60 * (index + 1)));
			});
			const { outcome } = plan;
			if (outcome)
				timers.push(
					window.setTimeout(() => settle(outcome), 60 * (events.length + 2)),
				);
			return {
				done,
				cancel() {
					for (const timer of timers) clearTimeout(timer);
					settle({ ok: false, error: { code: "cancelled" } });
				},
			};
		},
		// Pas encore de scénario d'identification dans la galerie : elle ne finit
		// qu'à l'annulation.
		identify() {
			let settle!: (response: BgResponse<IdentificationResult>) => void;
			const done = new Promise<BgResponse<IdentificationResult>>((resolve) => {
				settle = resolve;
			});
			return {
				done,
				cancel: () => settle({ ok: false, error: { code: "cancelled" } }),
			};
		},
		openLogin: async () =>
			plan.loginFails
				? { ok: false, error: { code: "popup_unavailable" } }
				: { ok: true, data: null },
	};
}

/** Magasin simulé : le résultat gardé de l'annonce, ou rien. */
function fakeStore(
	listing: Listing,
	result: AnalysisResult | null,
): AiResultStore {
	return {
		get: async () =>
			result
				? {
						result,
						identification: null,
						identifiedByUser: false,
						fingerprint: listingFingerprint(listing),
						storedAt: Date.now(),
					}
				: null,
		put: async () => {},
		prune: async () => {},
	};
}

// --- Scénarios -----------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attend qu'un élément du shadow root existe (au plus 3 s). */
async function waitFor<T extends Element>(
	root: ShadowRoot,
	selector: string,
): Promise<T> {
	for (let i = 0; i < 60; i++) {
		const found = root.querySelector<T>(selector);
		if (found) return found;
		await sleep(50);
	}
	throw new Error(`galerie : ${selector} introuvable`);
}

/** Clic sur la pilule (premier bouton), une fois qu'elle est rendue. */
const clickPill = async (root: ShadowRoot, selector = "button") =>
	(await waitFor<HTMLElement>(root, selector)).click();

/** Lance l'analyse, puis ouvre le panneau sur son résultat. */
async function launchThenOpen(root: ShadowRoot) {
	await clickPill(root);
	await clickPill(root, "button[aria-describedby][aria-expanded='false']");
}

/** Lance l'analyse et ouvre le panneau pendant qu'elle tourne. */
async function launchAndOpenWhileLoading(root: ShadowRoot) {
	await clickPill(root);
	await clickPill(root, "button[aria-busy='true']");
}

/** Affiche l'infobulle d'une icône de carte (survol simulé). */
async function hoverCard(root: ShadowRoot) {
	const button = await waitFor<HTMLElement>(root, "button");
	button.dispatchEvent(
		new MouseEvent("mouseover", { bubbles: true, composed: true }),
	);
}

// --- Montage -------------------------------------------------------------------

interface Stage {
	id: string;
	label: string;
	kind?: "tall" | "card";
	render(locale: Locale): {
		node: ReactNode;
		script?: (root: ShadowRoot) => Promise<void>;
	};
}

/** Pastille de fiche d'un état : client, magasin et accès en cache simulés. */
function badge(
	id: string,
	locale: Locale,
	plan: ClientPlan,
	options: {
		stored?: AnalysisResult;
		cachedAccess?: ContentAccess;
		professional?: boolean;
	} = {},
): ReactNode {
	const listing = listingOf(id, locale, options.professional);
	const accessCache = createAccessCache();
	if (options.cachedAccess)
		accessCache.settle(accessCache.begin(), options.cachedAccess);
	return (
		<RiskBadge
			report={REPORT}
			listing={listing}
			locale={locale}
			ai={fakeClient(plan)}
			accessCache={accessCache}
			aiResults={fakeStore(listing, options.stored ?? null)}
		/>
	);
}

/** État d'analyse en cours d'une icône de carte, après `events`. */
function loadingState(events: ScanProgressEvent[]): ScanState {
	let progress = startProgress(Date.now());
	for (const event of events) progress = addEvent(progress, event, Date.now());
	return { status: "loading", progress };
}

const PILLS: Stage[] = [
	{
		id: "pill-idle",
		label: "pilule au repos",
		render: (locale) => ({
			node: badge("repos", locale, { access: active(3) }),
		}),
	},
	{
		id: "pill-empty",
		label: "pilule au repos, sans analyse restante",
		render: (locale) => ({
			node: badge(
				"vide",
				locale,
				{ access: active(0) },
				{ cachedAccess: active(0) },
			),
		}),
	},
	{
		id: "pill-loading",
		label: "pilule en cours (attente après 4 s)",
		render: (locale) => ({
			node: badge("cours", locale, {
				access: active(3),
				events: SEARCHES.slice(0, 2),
			}),
			script: clickPill,
		}),
	},
	{
		id: "pill-loading-long",
		label: "pilule en cours, ligne d'état de 200 caractères",
		render: (locale) => ({
			node: badge("long", locale, {
				access: active(3),
				events: [{ type: "search", id: 1, query: LONG_QUERY, aspect: "scam" }],
			}),
			script: clickPill,
		}),
	},
	{
		id: "pill-low",
		label: "pilule, résultat faible",
		render: (locale) => ({
			node: badge(
				"faible",
				locale,
				{ access: active(3) },
				{ stored: RESULTS.low },
			),
		}),
	},
	{
		id: "pill-medium",
		label: "pilule, résultat moyen",
		render: (locale) => ({
			node: badge(
				"moyen",
				locale,
				{ access: active(3) },
				{ stored: { ...RESULTS.medium, professional: false } },
			),
		}),
	},
	{
		id: "pill-high",
		label: "pilule, résultat élevé",
		render: (locale) => ({
			node: badge(
				"eleve",
				locale,
				{ access: active(3) },
				{ stored: RESULTS.high },
			),
		}),
	},
	{
		id: "pill-error-relaunch",
		label: "pilule en erreur (analyse interrompue)",
		render: (locale) => ({
			node: badge("interrompue", locale, {
				access: active(3),
				events: SEARCHES.slice(0, 1),
				outcome: { ok: false, error: { code: "stream_interrupted" } },
			}),
			script: clickPill,
		}),
	},
	{
		id: "pill-error-launch",
		label: "pilule en erreur (message long, « Analyser »)",
		render: (locale) => ({
			node: badge("erreur", locale, {
				access: active(3),
				outcome: { ok: false, error: { code: "analysis_failed" } },
			}),
			script: clickPill,
		}),
	},
];

const PANELS: Stage[] = [
	{
		id: "panel-high",
		label: "panneau, résultat élevé",
		kind: "tall",
		render: (locale) => ({
			node: badge("panneau-eleve", locale, {
				access: active(3),
				events: SEARCHES,
				outcome: { ok: true, data: RESULTS.high },
			}),
			script: launchThenOpen,
		}),
	},
	{
		id: "panel-pro",
		label: "panneau, annonce professionnelle",
		kind: "tall",
		render: (locale) => ({
			node: badge(
				"panneau-pro",
				locale,
				{ access: active(3) },
				{ stored: RESULTS.medium, professional: true },
			),
			script: (root) => clickPill(root),
		}),
	},
	{
		id: "panel-signed-out",
		label: "panneau, compte déconnecté (popup indisponible)",
		kind: "tall",
		render: (locale) => ({
			node: badge("panneau-deconnecte", locale, {
				access: { status: "signedOut" },
				loginFails: true,
			}),
			script: clickPill,
		}),
	},
	{
		id: "panel-error-pricing",
		label: "panneau, erreur avec lien vers les formules",
		kind: "tall",
		render: (locale) => ({
			node: badge("panneau-formule", locale, {
				access: active(3),
				events: SEARCHES.slice(0, 1),
				outcome: { ok: false, error: { code: "feature_not_in_plan" } },
			}),
			script: launchAndOpenWhileLoading,
		}),
	},
	{
		id: "panel-error-login",
		label: "panneau, session expirée pendant l'analyse",
		kind: "tall",
		render: (locale) => ({
			node: badge("panneau-session", locale, {
				access: active(3),
				events: SEARCHES.slice(0, 1),
				outcome: { ok: false, error: { code: "session_expired" } },
			}),
			script: launchAndOpenWhileLoading,
		}),
	},
];

const cardResult: AnalysisResult = {
	...RESULTS.high,
	partial: true,
	webSearches: [],
};

const CARDS: Stage[] = [
	{
		id: "card-idle",
		label: "carte au repos",
		kind: "card",
		render: (locale) => ({
			node: (
				<CardBadge
					state={{ status: "idle" }}
					locale={locale}
					onActivate={noop}
				/>
			),
		}),
	},
	{
		id: "card-loading",
		label: "carte en cours (infobulle)",
		kind: "card",
		render: (locale) => ({
			node: (
				<CardBadge
					state={loadingState([
						{ type: "search", id: 1, query: LONG_QUERY, aspect: "scam" },
					])}
					locale={locale}
					onActivate={noop}
				/>
			),
			script: hoverCard,
		}),
	},
	{
		id: "card-done",
		label: "carte, résultat (infobulle)",
		kind: "card",
		render: (locale) => ({
			node: (
				<CardBadge
					state={{ status: "done", result: cardResult, progress: null }}
					locale={locale}
					onActivate={noop}
				/>
			),
			script: hoverCard,
		}),
	},
	{
		id: "card-pro",
		label: "carte, résultat professionnel (infobulle)",
		kind: "card",
		render: (locale) => ({
			node: (
				<CardBadge
					state={{
						status: "done",
						result: { ...RESULTS.medium, partial: true },
						progress: null,
					}}
					locale={locale}
					onActivate={noop}
				/>
			),
			script: hoverCard,
		}),
	},
	{
		id: "card-error",
		label: "carte en erreur",
		kind: "card",
		render: (locale) => ({
			node: (
				<CardBadge
					state={{ status: "error", code: "rate_limited" }}
					locale={locale}
					onActivate={noop}
				/>
			),
		}),
	},
];

function noop() {}

/** Monte `node` dans un shadow root ouvert sous `slot`, puis joue `script`. */
function mountShadow(
	slot: HTMLElement,
	node: ReactNode,
	script?: (root: ShadowRoot) => Promise<void>,
) {
	const host = document.createElement("span");
	slot.append(host);
	const shadow = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = SHADOW_CSS;
	const container = document.createElement("span");
	shadow.append(style, container);
	createRoot(container).render(node);
	if (script)
		void script(shadow).catch((error: unknown) => console.error(error));
}

/** Une fiche fictive (titre) ou une carte de résultats, avec l'état monté dedans. */
function renderStage(stage: Stage, locale: Locale, grid: HTMLElement) {
	const figure = document.createElement("figure");
	figure.className = `gallery-stage${stage.kind ? ` is-${stage.kind}` : ""}`;
	figure.dataset.stage = `${stage.id}-${locale}`;
	const caption = document.createElement("figcaption");
	caption.textContent = `${stage.id} · ${stage.label}`;
	figure.append(caption);

	const { node, script } = stage.render(locale);
	let slot: HTMLElement;
	if (stage.kind === "card") {
		const card = document.createElement("article");
		card.className = "listing-card";
		card.innerHTML =
			'<div class="photo"></div><div class="body"><p class="card-title"></p><p class="price">180 €</p></div>';
		slot = card.querySelector<HTMLElement>(".card-title") as HTMLElement;
		slot.textContent = TITLES[locale];
		figure.append(card);
	} else {
		slot = document.createElement("h1");
		slot.className = "listing-title";
		slot.textContent = TITLES[locale];
		figure.append(slot);
	}
	grid.append(figure);
	mountShadow(slot, node, script);
}

const GROUPS: Array<[string, Stage[]]> = [
	["Pilule de la fiche", PILLS],
	["Panneau", PANELS],
	["Icônes des cartes", CARDS],
];

const LOCALE_NAMES: Record<Locale, string> = {
	fr: "Français",
	nl: "Nederlands",
};

const requested = new URLSearchParams(location.search).get("lang");
const locales: Locale[] =
	requested === "fr" || requested === "nl" ? [requested] : ["fr", "nl"];
const main = document.getElementById("gallery") as HTMLElement;
for (const locale of locales) {
	const section = document.createElement("section");
	section.lang = locale;
	const heading = document.createElement("h2");
	heading.className = "gallery-locale";
	heading.textContent = LOCALE_NAMES[locale];
	section.append(heading);
	for (const [title, stages] of GROUPS) {
		const group = document.createElement("h3");
		group.className = "gallery-group";
		group.textContent = title;
		const grid = document.createElement("div");
		grid.className = "gallery-grid";
		section.append(group, grid);
		for (const stage of stages) renderStage(stage, locale, grid);
	}
	main.append(section);
}
