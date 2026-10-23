import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AnalysisResult,
	IdentificationResult,
	ScanProgressEvent,
} from "@radarnaque/shared";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { browser } from "wxt/browser";
import { RiskBadge } from "../components/RiskBadge";
import { createAccessCache, RECHECK_MS } from "../lib/content/access-policy";
import type { AiClient } from "../lib/content/ai-client";
import {
	type AiResultStore,
	createAiResultStore,
	listingFingerprint,
	type StorageAreaLike,
	type StoredAiEntry,
	type StoredAiResult,
} from "../lib/content/ai-results";
import { aiErrorText, contentText } from "../lib/content-i18n";
import type { Listing } from "../lib/listing/types";
import type { BgResponse, ContentAccess, ScanRequest } from "../lib/messages";
import type { RiskReport } from "../lib/rules/score";
import {
	debugAnalysis,
	sampleAnalysis,
	sampleDebug,
	sampleIdentification,
} from "./helpers";

afterEach(cleanup);

const listing: Listing = {
	site: "2ememain.be",
	externalId: "m123",
	url: "https://www.2ememain.be/v/velo/m123",
	title: "Vélo",
	description: "Bon état.",
	price: { amountCents: 15000, currency: "EUR" },
	priceType: "fixed",
	location: { city: "Namur" },
	images: [],
	seller: { id: "42", name: "Vendeur", reviewCount: 4 },
};

const active: ContentAccess = {
	status: "active",
	features: [],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
};

/** Issue d'une analyse simulée, réglée par chaque test. */
type ScanReply = (req: ScanRequest) => Promise<BgResponse<AnalysisResult>>;

/** Client IA simulé : accès actif, scans réussis. Recréé avant chaque test. */
let ai: AiClient & {
	access: ReturnType<typeof vi.fn<AiClient["access"]>>;
	scan: ReturnType<typeof vi.fn<AiClient["scan"]>>;
	identify: ReturnType<typeof vi.fn<AiClient["identify"]>>;
	openLogin: ReturnType<typeof vi.fn<AiClient["openLogin"]>>;
};
/** Issue d'une identification simulée, réglée par chaque test. */
type IdentifyReply = (
	req: ScanRequest,
) => Promise<BgResponse<IdentificationResult>>;
/** L'issue de chaque analyse (`done`), sans événement de progression. */
let scanReply: ReturnType<typeof vi.fn<ScanReply>>;
/** L'issue de chaque identification : Steam Deck OLED, sûr à 95 %. */
let identifyReply: ReturnType<typeof vi.fn<IdentifyReply>>;
beforeEach(() => {
	scanReply = vi.fn<ScanReply>(async () => ({
		ok: true,
		data: sampleAnalysis,
	}));
	identifyReply = vi.fn<IdentifyReply>(async () => ({
		ok: true,
		data: sampleIdentification,
	}));
	ai = {
		access: vi.fn<AiClient["access"]>(async () => ({ ok: true, data: active })),
		scan: vi.fn<AiClient["scan"]>((req) => ({
			done: scanReply(req),
			cancel: () => {},
		})),
		identify: vi.fn<AiClient["identify"]>((req) => ({
			done: identifyReply(req),
			cancel: () => {},
		})),
		openLogin: vi.fn<AiClient["openLogin"]>(async () => ({
			ok: true,
			data: null,
		})),
	};
});

const low: RiskReport = {
	score: 0,
	level: "low",
	signals: [],
	rulesVersion: 1,
};
const high: RiskReport = {
	score: 90,
	level: "high",
	rulesVersion: 1,
	signals: [
		{ id: "short_description", weight: 10, severity: "info" },
		{ id: "no_reviews", weight: 10, severity: "warning" },
		{ id: "new_account", weight: 25, severity: "danger" },
	],
};
const medium: RiskReport = {
	score: 40,
	level: "medium",
	rulesVersion: 1,
	signals: [
		{ id: "new_account", weight: 25, severity: "danger" },
		{ id: "no_reviews", weight: 15, severity: "warning" },
	],
};
/** Textes de l'ancienne analyse locale : plus jamais affichés. */
const LOCAL_TEXTS = [
	"Compte vendeur très récent",
	"Aucun avis sur le vendeur",
	"Description très courte",
	"Analyse locale, sans IA",
	"Aucun signal d'alerte détecté.",
];
const aiHigh: AnalysisResult = {
	...sampleAnalysis,
	level: "high",
	score: 82,
	summary: { fr: "Arnaque probable.", nl: "Waarschijnlijk oplichting." },
};

const LAUNCH = contentText("fr", "ai.analyzeRisk");
const IDENTIFY = contentText("fr", "identify.launch");
const PANEL_CLOSE = contentText("fr", "panel.close");
/** Nom accessible de la partie produit de la pilule « Produit identifié ». */
const SURE = "Identification : Steam Deck OLED · Sûr";
/**
 * Action « Analyser le risque » de la pilule (produit identifié, ou erreur),
 * hors du panneau, qui a son propre bouton du même nom.
 */
const outsidePanel = (elements: HTMLElement[]) =>
	elements.filter((element) => !element.closest("[role='dialog']"));
const pillLaunches = () =>
	outsidePanel(screen.queryAllByRole("button", { name: LAUNCH }));
const launch = () => {
	const [button] = pillLaunches();
	if (!button) throw new Error("Pas de bouton « Analyser le risque » (pilule)");
	return button;
};
const queryLaunch = () => pillLaunches()[0] ?? null;
const findLaunch = () => vi.waitFor(() => launch());
/** Tous les contrôles « Analyser le risque » de la pilule (bouton ou lien). */
const launchControls = (locale: "fr" | "nl" = "fr") =>
	outsidePanel([
		...screen.queryAllByRole("button", {
			name: contentText(locale, "ai.analyzeRisk"),
		}),
		...screen.queryAllByRole("link", {
			name: contentText(locale, "ai.analyzeRisk"),
		}),
	]);
/**
 * Pilule au repos : « Identifier », nommée « Identifier le produit » (le
 * panneau a son propre bouton du même nom).
 */
const identifyButton = () => {
	const [button, ...others] = screen
		.getAllByRole("button", { name: IDENTIFY })
		.filter((element) => !element.closest("[role='dialog']"));
	if (!button || others.length > 0)
		throw new Error("une seule pilule « Identifier » attendue");
	return button;
};
/** Tous les contrôles « Identifier » de la pilule (bouton ou lien), hors panneau. */
const identifyControls = (locale: "fr" | "nl" = "fr") =>
	[
		...screen.queryAllByRole("button", {
			name: contentText(locale, "identify.launch"),
		}),
		...screen.queryAllByRole("link", {
			name: contentText(locale, "identify.launch"),
		}),
	].filter((element) => !element.closest("[role='dialog']"));
/** Partie produit de la pilule : elle ouvre ou ferme le panneau. */
const product = () => screen.getByRole("button", { name: SURE });
/** Pilule d'une analyse en cours ou de son résultat : elle ouvre le panneau. */
const toggle = () => screen.getByRole("button", { name: /Radarnaque/ });
const findToggle = () => screen.findByRole("button", { name: /Radarnaque/ });
const described = () =>
	(toggle().getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent);

/** Accès déjà en cache (lu par une icône de carte, ou plus tôt). */
const cached = (access: ContentAccess) => {
	const cache = createAccessCache();
	cache.settle(cache.begin(), access);
	return cache;
};

/** Magasin simulé : une entrée par `site|externalId`. */
const storeWith = (entries: Record<string, StoredAiResult>): AiResultStore => ({
	get: async (site, id) => entries[`${site}|${id}`] ?? null,
	put: async () => {},
	prune: async () => {},
	forgetIdentifiedByUser: async () => {},
});

/** Identification faite par l'utilisateur, gardée pour `l` (sans analyse). */
const identifiedEntry = (l: Listing = listing, byUser = true) => ({
	[`${l.site}|${l.externalId}`]: {
		result: null,
		identification: sampleIdentification,
		identifiedByUser: byUser,
		fingerprint: listingFingerprint(l),
		storedAt: 1,
	},
});

/** Identifie depuis la pilule au repos ; rend l'action « Analyser le risque ». */
async function identifyFirst(user: ReturnType<typeof userEvent.setup>) {
	await user.click(identifyButton());
	return findLaunch();
}

/**
 * Pastille déjà identifiée (identification reprise du magasin, faite par
 * l'utilisateur sauf `byUser: false`) : l'action « Analyser le risque » est
 * affichée, aucun accès n'a encore été lu.
 */
async function renderIdentified({
	byUser = true,
	page = false,
	...props
}: Partial<Parameters<typeof RiskBadge>[0]> & {
	byUser?: boolean;
	/** Un bouton « page » de la page hôte avant la pastille. */
	page?: boolean;
} = {}) {
	const badge = (
		<RiskBadge
			report={high}
			listing={listing}
			locale="fr"
			ai={ai}
			aiResults={storeWith(identifiedEntry(listing, byUser))}
			{...props}
		/>
	);
	const view = render(
		page ? (
			<div>
				<button type="button">page</button>
				{badge}
			</div>
		) : (
			badge
		),
	);
	await findLaunch();
	return view;
}

/**
 * Lance l'analyse du risque depuis la pilule (identifie d'abord si besoin) et
 * attend son résultat (`score`/100).
 */
async function launchToResult(
	user: ReturnType<typeof userEvent.setup>,
	score = sampleAnalysis.score,
) {
	await user.click(queryLaunch() ?? (await identifyFirst(user)));
	await vi.waitFor(() =>
		expect(toggle().textContent).toContain(`${score}/100`),
	);
}

describe("RiskBadge", () => {
	test("au repos : une seule pilule « Identifier », aucun niveau ni score local", () => {
		const { container } = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
		);
		expect(container.textContent).not.toContain("Risque");
		expect(container.textContent).not.toContain("90/100");
		// Ni couleur de niveau, ni nom accessible qui l'évoquerait.
		expect(
			container.querySelector(".bg-danger, .bg-warning, .bg-success"),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /Radarnaque/ })).toBeNull();
		expect(identifyControls()).toHaveLength(1);
		expect(launchControls()).toHaveLength(0);
		expect(identifyButton().textContent).toBe(
			contentText("fr", "identify.launchShort"),
		);
		expect(identifyButton().getAttribute("type")).toBe("button");
		expect(identifyButton().hasAttribute("aria-expanded")).toBe(false);
		// Une seule pilule : un seul conteneur et une seule région annoncée.
		expect(container.querySelectorAll("[data-pill]")).toHaveLength(1);
		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("au repos, le clic lance l'identification (accès actif en cache) sans ouvrir de panneau", () => {
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		fireEvent.click(identifyButton());
		expect(ai.identify).toHaveBeenCalledTimes(1);
		expect(ai.scan).not.toHaveBeenCalled();
		expect(ai.access).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("résultat IA : pilule niveau et score de l'IA, décrite par eux ; un clic ouvre le panneau, un second le ferme", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await launchToResult(user, 82);
		expect(toggle().textContent).toContain("Risque élevé");
		expect(toggle().textContent).not.toContain("40/100");
		expect(toggle().getAttribute("type")).toBe("button");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("fr", "badge.aria"),
		);
		expect(described()).toEqual(["Risque élevé", "82/100"]);
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(queryLaunch()).toBeNull();

		await user.click(toggle());
		expect(
			screen.getByRole("dialog", { name: contentText("fr", "panel.title") }),
		).toBeTruthy();
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});

	test("panneau : titre « Analyse Radarnaque », ni signaux locaux ni pied de page local", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await launchToResult(user, 82);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: "Analyse Radarnaque",
		});
		expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(
			"Analyse Radarnaque",
		);
		expect(dialog.textContent).toContain(aiHigh.summary.fr);
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		expect(dialog.textContent).not.toContain("90/100");
	});

	test("Escape ferme le panneau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});

	test("un clic hors de la pastille ferme le panneau, un clic dedans non", async () => {
		const user = userEvent.setup();
		render(
			<div>
				<button type="button">ailleurs</button>
				<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />
			</div>,
		);
		await launchToResult(user);
		await user.click(toggle());
		await user.click(screen.getByRole("dialog"));
		expect(screen.getByRole("dialog")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "ailleurs" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("dans un Shadow DOM : clic à l'intérieur conservé, clic sur la page ferme", async () => {
		const user = userEvent.setup();
		const host = document.createElement("div");
		document.body.append(host);
		const outside = document.createElement("button");
		outside.textContent = "page";
		document.body.append(outside);
		const shadow = host.attachShadow({ mode: "open" });
		const container = document.createElement("div");
		shadow.append(container);
		const view = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
			{ container },
		);
		await user.click(within(container).getByRole("button", { name: IDENTIFY }));
		await user.click(
			await within(container).findByRole("button", { name: LAUNCH }),
		);
		await user.click(
			await within(container).findByRole("button", { name: /Radarnaque/ }),
		);
		await user.click(within(container).getByRole("dialog"));
		expect(within(container).queryByRole("dialog")).not.toBeNull();
		await user.click(outside);
		expect(within(container).queryByRole("dialog")).toBeNull();
		view.unmount();
		host.remove();
		outside.remove();
	});

	test("locale nl : libellés en néerlandais", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(<RiskBadge report={high} listing={listing} locale="nl" ai={ai} />);
		const button = screen.getByRole("button", {
			name: contentText("nl", "identify.launch"),
		});
		expect(button.textContent).toBe("Identificeren");
		await user.click(button);
		const action = await screen.findByRole("button", {
			name: "Risico analyseren",
		});
		expect(
			screen.getByRole("button", {
				name: "Identificatie: Steam Deck OLED · Zeker",
			}),
		).toBeTruthy();
		await user.click(action);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(toggle().textContent).toContain("Hoog risico");
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("nl", "badge.aria"),
		);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("nl", "panel.title"),
		});
		expect(dialog.textContent).toContain(aiHigh.summary.nl);
		expect(dialog.textContent).not.toContain("Zeer recent verkopersaccount");
	});

	test("lancer l'analyse ne passe que par le client IA injecté : ni fetch, ni sendMessage direct", async () => {
		const user = userEvent.setup();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		// Ouvrir le panneau ne relance rien.
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("Escape ouvert est consommé : un écouteur document ultérieur ne le reçoit pas", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		const bubble = vi.fn();
		const capture = vi.fn();
		document.addEventListener("keydown", bubble);
		document.addEventListener("keydown", capture, true);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(bubble).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		// Panneau fermé : Escape n'est plus intercepté.
		await user.keyboard("{Escape}");
		expect(bubble).toHaveBeenCalledTimes(1);
		document.removeEventListener("keydown", bubble);
		document.removeEventListener("keydown", capture, true);
	});
});

describe("RiskBadge : panneau", () => {
	/** Résultat high 82, panneau ouvert. */
	const openHigh = async (
		user: ReturnType<typeof userEvent.setup>,
		locale: "fr" | "nl" = "fr",
	) => {
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale={locale}
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(
			screen.getByRole("button", {
				name: contentText(locale, "identify.launch"),
			}),
		);
		await user.click(
			await screen.findByRole("button", {
				name: contentText(locale, "ai.analyzeRisk"),
			}),
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		await user.click(toggle());
		return screen.getByRole("dialog", {
			name: contentText(locale, "panel.title"),
		});
	};

	test("panneau : en-tête avec le titre et un bouton « Fermer » qui ferme et rend le focus à la pilule", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		const header = dialog.firstElementChild;
		if (!header) throw new Error("en-tête attendu");
		// Logo 14 px, titre en style label, bouton de fermeture.
		const logo = header.querySelector("svg");
		expect(logo?.getAttribute("width")).toBe("14");
		expect(logo?.getAttribute("aria-hidden")).toBe("true");
		const title = within(header as HTMLElement).getByRole("heading", {
			level: 2,
		});
		expect(title.textContent).toBe("Analyse Radarnaque");
		for (const name of ["uppercase", "text-[11px]", "tracking-[0.06em]"])
			expect(title.classList.contains(name), name).toBe(true);
		const close = within(header as HTMLElement).getByRole("button", {
			name: "Fermer",
		});
		expect(close.getAttribute("type")).toBe("button");
		// Icône Lucide « close » : deux traits, décorative.
		const icon = close.querySelector("svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(icon?.querySelectorAll("path")).toHaveLength(2);

		await user.click(close);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(toggle());
	});

	test("fermer au clavier : Entrée sur « Fermer », le focus revient à la pilule", async () => {
		const user = userEvent.setup();
		await openHigh(user);
		screen.getByRole("button", { name: "Fermer" }).focus();
		await user.keyboard("{Enter}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(toggle());
	});

	test("nl : « Sluiten »", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user, "nl");
		const close = within(dialog).getByRole("button", { name: "Sluiten" });
		await user.click(close);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("carte : verre sombre, bordure, --r-m, ombre flottante, filet en dégradé, 340 px au plus 90 vw", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		for (const name of [
			"bg-glass-host",
			"border-border-default",
			"rounded-md",
			"shadow-[var(--shadow-float)]",
			"w-[340px]",
			"max-w-[90vw]",
			"z-[2147483000]",
			"before:bg-[image:var(--gradient-hairline)]",
			"before:h-0.5",
		])
			expect(dialog.classList.contains(name), name).toBe(true);
		expect(dialog.className).not.toMatch(
			/\bslate-|\bbg-white(?![\w/])|2147483647/,
		);
	});

	test("filet : le dégradé forme le bord haut, sans bordure grise au-dessus (border-t-0)", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		expect(dialog.classList.contains("border-t-0")).toBe(true);
		expect(dialog.classList.contains("before:top-0")).toBe(true);
	});

	test("pilule près du bord droit : le panneau est décalé vers la gauche, la page ne défile pas", async () => {
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
			1280,
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const shift = Number.parseFloat(this.style.left || "0");
				return DOMRect.fromRect({ x: 1100 + shift, y: 0, width: 340 });
			},
		);
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		expect(dialog.style.left).toBe("-168px");
	});

	test("panneau ouvert pendant l'analyse, la pilule change de largeur et de place : le décalage suit", async () => {
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
			1280,
		);
		let x = 1100;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const shift = Number.parseFloat(this.style.left || "0");
				return DOMRect.fromRect({ x: x + shift, y: 0, width: 340 });
			},
		);
		let finish!: (response: BgResponse<AnalysisResult>) => void;
		scanReply.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(await identifyFirst(user));
		await user.click(await findToggle());
		const dialog = screen.getByRole("dialog");
		expect(dialog.style.left).toBe("-168px");
		// Le résultat arrive : la pilule rétrécit, la racine passe à la ligne, à gauche.
		x = 40;
		await act(async () => {
			finish({ ok: true, data: aiHigh });
		});
		expect(screen.getByRole("dialog").style.left).toBe("");
	});

	test("contraste : la pilule et le panneau sont en verre opaque des pages tierces (bg-glass-host), jamais bg-glass-strong", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		for (const surface of [toggle(), dialog]) {
			expect(surface.classList.contains("bg-glass-host")).toBe(true);
			expect(surface.classList.contains("bg-glass-strong")).toBe(false);
		}
	});

	test("aucune classe z-[2147483647] dans RiskBadge", () => {
		const source = readFileSync(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				"../components/RiskBadge.tsx",
			),
			"utf8",
		);
		expect(source).not.toContain("2147483647");
		expect(source).toContain("z-[2147483000]");
	});

	test("résultat dans le panneau : score serif, badge de verdict, barre", async () => {
		const user = userEvent.setup();
		const dialog = await openHigh(user);
		const score = within(dialog).getByText("82");
		expect(score.classList.contains("font-serif")).toBe(true);
		expect(score.nextElementSibling?.textContent).toBe("/100");
		expect(
			within(dialog).getByText("Risque élevé").closest("[data-verdict]"),
		).not.toBeNull();
		// La barre de la section IA, avant celle de « Détail du produit ».
		const analysis = within(dialog).getAllByRole("region").at(0);
		const fill = analysis?.querySelector("[role='presentation']")
			?.firstElementChild as HTMLElement | null;
		expect(fill?.style.width).toBe("82%");
	});
});

describe("RiskBadge : analyse IA", () => {
	/** Bouton « Identifier le produit » du panneau, affiché une fois l'accès chargé. */
	const findRun = async () =>
		within(await screen.findByRole("dialog")).findByRole("button", {
			name: IDENTIFY,
		});
	/** Déconnecté, popup de connexion impossible : le clic ouvre le panneau. */
	const signedOutWithoutPopup = () => {
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
	};

	test("analyse lancée, panneau fermé puis rouvert : le résultat reste, un seul scan", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		await user.click(toggle());
		expect(screen.getByText(sampleAnalysis.summary.fr)).toBeTruthy();

		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(toggle());
		expect(screen.getByText(sampleAnalysis.summary.fr)).toBeTruthy();
		expect(ai.scan).toHaveBeenCalledTimes(1);
		// Le composant est resté monté : seul le panneau s'est fermé.
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
	});

	test("la demande d'analyse contient toujours signals et rulesVersion du rapport local", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(await identifyFirst(user));
		await vi.waitFor(() => expect(ai.scan).toHaveBeenCalledTimes(1));
		const request = {
			listing,
			signals: high.signals,
			rulesVersion: high.rulesVersion,
			trigger: "button",
			partial: false,
		};
		expect(ai.scan).toHaveBeenCalledWith(request, expect.any(Function));
		// L'identification part avec la même demande.
		expect(ai.identify).toHaveBeenCalledWith(request, expect.any(Function));
	});

	test("double clic sur « Analyser le risque » : une seule requête", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.dblClick(await identifyFirst(user));
		await findToggle();
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("double clic sur « Identifier » : une seule identification", async () => {
		const user = userEvent.setup();
		identifyReply.mockImplementation(() => new Promise(() => {}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.dblClick(identifyButton());
		await findToggle();
		expect(ai.identify).toHaveBeenCalledTimes(1);
	});

	test("R3 : session expirée pendant un scan, l'accès relu (signedOut) ne laisse que la connexion", async () => {
		const user = userEvent.setup();
		ai.access
			.mockResolvedValueOnce({ ok: true, data: active })
			.mockResolvedValueOnce({ ok: true, data: { status: "signedOut" } });
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		await renderIdentified();
		await user.click(launch());
		// Analyse en cours : le panneau est ouvert sur son déroulé.
		await user.click(await findToggle());
		await act(async () =>
			answer({ ok: false, error: { code: "session_expired" } }),
		);

		const dialog = screen.getByRole("dialog");
		await within(dialog).findByText(contentText("fr", "ai.loginHint"));
		expect(ai.access).toHaveBeenCalledTimes(2);
		expect(
			screen.getAllByRole("button", { name: contentText("fr", "ai.login") }),
		).toHaveLength(1);
	});

	test("R8 : accès en erreur, le clic ouvre le panneau ; nouvel essai après 30 s seulement, puis le bouton d'identification", async () => {
		const user = userEvent.setup();
		let clock = 0;
		const accessCache = createAccessCache(() => clock);
		ai.access.mockResolvedValueOnce({
			ok: false,
			error: { code: "background_unavailable" },
		});
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		await user.click(identifyButton());
		await screen.findByText(aiErrorText("fr", "background_unavailable"));
		expect(screen.getByRole("dialog")).toBeTruthy();
		await user.keyboard("{Escape}");
		await user.click(identifyButton());
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(ai.access).toHaveBeenCalledTimes(1);
		await user.keyboard("{Escape}");
		clock += RECHECK_MS;
		await user.click(identifyButton());
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(2);
		expect(ai.identify).not.toHaveBeenCalled();
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("signedOut, panneau ouvert, retour sur l'onglet (focus) : accès relu, le panneau passe à active", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		const reads = ai.access.mock.calls.length;

		// Connexion faite dans la popup ; la page reprend le focus.
		ai.access.mockImplementation(async () => ({ ok: true, data: active }));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(reads + 1);
		expect(screen.queryByText(contentText("fr", "ai.loginHint"))).toBeNull();
	});

	test("signedOut, panneau ouvert, onglet de nouveau visible : accès relu", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		const reads = ai.access.mock.calls.length;
		ai.access.mockImplementation(async () => ({ ok: true, data: active }));
		const state = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("visible");
		fireEvent(document, new Event("visibilitychange"));
		await findRun();
		expect(ai.access).toHaveBeenCalledTimes(reads + 1);
		state.mockRestore();
	});

	test("accès actif : focus ou panneau rouvert ne relisent pas l'accès", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		// Lu au clic sur « Identifier », puis relu après l'identification et
		// après l'analyse.
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(3));
		await user.click(toggle());
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await user.click(toggle());
		await user.click(toggle());
		expect(ai.access).toHaveBeenCalledTimes(3);
	});

	test("panneau fermé : focus ne relit pas l'accès", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		await user.keyboard("{Escape}");
		const reads = ai.access.mock.calls.length;
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(ai.access).toHaveBeenCalledTimes(reads);
	});

	test("no photo-scan button : une seule action dans le panneau, avec ou sans photos", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(
			<RiskBadge
				report={high}
				listing={{ ...listing, images: ["https://images.example/1.jpg"] }}
				locale="fr"
				ai={ai}
			/>,
		);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginHint"));
		ai.access.mockImplementation(async () => ({ ok: true, data: active }));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await findRun();
		// Une seule action, en plus du bouton « Fermer » de l'en-tête.
		const actions = within(screen.getByRole("dialog"))
			.getAllByRole("button")
			.filter((b) => b.getAttribute("aria-label") !== PANEL_CLOSE);
		expect(actions).toHaveLength(1);
		expect(screen.queryByText(/photos/)).toBeNull();
	});

	test("description modifiée puis clic : les requêtes portent la nouvelle description", async () => {
		const user = userEvent.setup();
		const accessCache = cached(active);
		const view = render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		view.rerender(
			<RiskBadge
				report={high}
				listing={{ ...listing, description: "Description complétée." }}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		await user.click(await identifyFirst(user));
		expect(ai.identify.mock.calls[0]?.[0].listing.description).toBe(
			"Description complétée.",
		);
		expect(ai.scan.mock.calls[0]?.[0].listing.description).toBe(
			"Description complétée.",
		);
	});

	test("sans abonnement, accès inconnu : le clic ouvre le panneau, lien vers les formules dans la langue active", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({
			ok: true,
			data: { status: "noSubscription" },
		});
		render(<RiskBadge report={high} listing={listing} locale="nl" ai={ai} />);
		await user.click(
			screen.getByRole("button", {
				name: contentText("nl", "identify.launch"),
			}),
		);
		const link = await screen.findByRole("link", {
			name: contentText("nl", "ai.pricing"),
		});
		expect(link.getAttribute("href")).toBe(
			"http://localhost:8080/pricing/?lang=nl",
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(ai.identify).not.toHaveBeenCalled();
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("Se connecter sans popup disponible : texte de repli, le clic dans le panneau ne le ferme pas", async () => {
		const user = userEvent.setup();
		signedOutWithoutPopup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginFallback"));
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "ai.login") }),
		);
		expect(ai.openLogin).toHaveBeenCalledTimes(2);
		expect(
			screen.getByText(contentText("fr", "ai.loginFallback")),
		).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});

describe("RiskBadge : pilule et ligne en direct", () => {
	afterEach(() => vi.useRealTimers());

	const searchEvent: ScanProgressEvent = {
		type: "search",
		id: 1,
		query: "iPhone 18 Pro prix",
		aspect: "price",
	};
	const SEARCH_LINE = "Recherche web (prix du marché) : “iPhone 18 Pro prix”";

	/** Envoie un événement du flux à l'analyse lancée en dernier. */
	const emit = (e: ScanProgressEvent) => {
		const onEvent = ai.scan.mock.calls.at(-1)?.[1];
		if (!onEvent) throw new Error("aucune analyse lancée");
		act(() => onEvent(e));
	};
	const statusLineEl = () => toggle().querySelector(".radarnaque-status");
	/** La seule région annoncée de la pastille. */
	const region = () => screen.getByRole("status");
	const announced = () => region().textContent;

	test("launch button starts scan without opening panel", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified();
		expect(ai.access).not.toHaveBeenCalled();
		const button = launch();
		expect(button.getAttribute("type")).toBe("button");
		expect(button.textContent).toBe("Analyser le risque");
		await user.click(button);
		// Accès inconnu : lu d'abord, puis l'analyse part. Elle part dans un effet,
		// après la réponse de l'accès (hors `act`) : `ai.scan` est appelé avant le
		// rendu de l'état `loading`. On attend donc ce rendu, pas l'appel.
		await vi.waitFor(() =>
			expect(toggle().querySelector(".rq-logo--loading")).not.toBeNull(),
		);
		expect(ai.scan).toHaveBeenCalledTimes(1);
		expect(ai.access).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		// Pendant l'analyse, la ligne en direct remplace le produit et l'action.
		expect(queryLaunch()).toBeNull();
		expect(screen.queryByRole("button", { name: SURE })).toBeNull();
		expect(toggle().textContent).not.toContain("90/100");
		// La référence du produit reste devant la ligne d'état.
		expect(toggle().textContent).toContain("Steam Deck OLED");
	});

	test("analyse en cours : le clic ouvre le panneau avec le déroulé", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await user.click(await identifyFirst(user));
		emit(searchEvent);
		await user.click(toggle());
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.textContent).toContain(contentText("fr", "ai.loading"));
		expect(within(dialog).getByText(SEARCH_LINE)).toBeTruthy();
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		await user.click(toggle());
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("absent dès qu'un résultat IA est affiché", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user);
		expect(queryLaunch()).toBeNull();
	});

	test("identify button when signed out opens login", async () => {
		const user = userEvent.setup();
		// Chaque réponse du service worker est un objet neuf (clone du message).
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await vi.waitFor(() => expect(ai.openLogin).toHaveBeenCalledTimes(1));
		expect(ai.identify).not.toHaveBeenCalled();
		expect(ai.scan).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
		// Déjà connu signedOut : relu (R8), puis la connexion à nouveau.
		await user.click(identifyButton());
		await vi.waitFor(() => expect(ai.openLogin).toHaveBeenCalledTimes(2));
		expect(ai.access).toHaveBeenCalledTimes(2);
	});

	test("« Analyser le risque » déconnecté : la connexion, sans analyse", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		await renderIdentified();
		await user.click(launch());
		await vi.waitFor(() => expect(ai.openLogin).toHaveBeenCalledTimes(1));
		expect(ai.scan).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("identify disabled when no scans left", async () => {
		const user = userEvent.setup();
		const empty: ContentAccess = { ...active, remaining: { scans: 0 } };
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(empty)}
			/>,
		);
		const button = identifyButton();
		// Grisé mais focusable : la raison est lue avec le bouton.
		expect(button.hasAttribute("disabled")).toBe(false);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("title")).toBe("Plus d'analyses IA disponibles");
		const reason = document.getElementById(
			button.getAttribute("aria-describedby") ?? "",
		);
		expect(reason?.textContent).toBe("Plus d'analyses IA disponibles");
		button.focus();
		expect(document.activeElement).toBe(button);
		await user.click(button);
		expect(ai.identify).not.toHaveBeenCalled();
		expect(ai.access).not.toHaveBeenCalled();
		cleanup();

		// Accès inconnu au clic : lu, puis grisé sans identification.
		ai.access.mockResolvedValue({ ok: true, data: empty });
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await vi.waitFor(() =>
			expect(identifyButton().getAttribute("aria-disabled")).toBe("true"),
		);
		expect(ai.identify).not.toHaveBeenCalled();
	});

	test("accès relu pendant que le panneau est ouvert (signedOut → sans abonnement) : la pilule devient le lien vers les formules, un seul contrôle « Identifier »", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginFallback"));
		expect(identifyControls()).toHaveLength(1);

		// Connexion faite dans la popup, sans abonnement ; la page reprend le focus.
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "noSubscription" },
		}));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		const link = await screen.findByRole("link", { name: IDENTIFY });
		expect(link.getAttribute("href")).toMatch(/\/pricing\/\?lang=fr$/);
		expect(link.textContent).toBe(contentText("fr", "identify.launchShort"));
		expect(identifyControls()).toHaveLength(1);
		// Le panneau, toujours ouvert, dit pourquoi.
		expect(screen.getByRole("dialog").textContent).toContain(
			aiErrorText("fr", "no_active_subscription"),
		);
	});

	test("accès relu à 0 analyse : la pilule reste focusable, aria-disabled, décrite par ai.noScansLeft", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		await screen.findByText(contentText("fr", "ai.loginFallback"));

		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await vi.waitFor(() =>
			expect(identifyButton().getAttribute("aria-disabled")).toBe("true"),
		);
		const button = identifyButton();
		expect(button.hasAttribute("disabled")).toBe(false);
		const reason = contentText("fr", "ai.noScansLeft");
		expect(button.getAttribute("title")).toBe(reason);
		expect(
			document.getElementById(button.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe(reason);
		button.focus();
		expect(document.activeElement).toBe(button);
		expect(identifyControls()).toHaveLength(1);
		await user.click(button);
		expect(ai.identify).not.toHaveBeenCalled();
	});

	test("analysis_failed lancée depuis la pastille : son texte, annoncé, et le bouton de lancement", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "analysis_failed" },
		});
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		const text = aiErrorText("fr", "analysis_failed");
		expect(await screen.findByText(text)).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		await vi.waitFor(() => expect(announced()).toBe(text), { timeout: 3_000 });
		// Pas « Relancer » : « Analyser le risque », qui relance l'analyse.
		expect(screen.queryByRole("button", { name: "Relancer" })).toBeNull();
		expect(launchControls()).toHaveLength(1);
		await user.click(launch());
		expect(ai.scan).toHaveBeenCalledTimes(2);
	});

	test("quota_exhausted lancée depuis la pastille : son texte, sans bouton (quota relu à 0)", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "quota_exhausted" },
		});
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		expect(
			await screen.findByText(aiErrorText("fr", "quota_exhausted")),
		).toBeTruthy();
		// L'accès relu après le scan dit 0 : le message suffit.
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(queryLaunch()).toBeNull());
	});

	test("analyse interrompue, accès relu à 0 sans inclusion : ni « Relancer » muet, ni bouton de lancement", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		await renderIdentified({ accessCache: cached(active), byUser: false });
		await user.click(launch());
		expect(
			await screen.findByText(aiErrorText("fr", "stream_interrupted")),
		).toBeTruthy();
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: "Relancer" })).toBeNull(),
		);
		expect(queryLaunch()).toBeNull();
	});

	test("échec d'une analyse suivie dans le panneau ouvert : son texte dans le panneau seulement", async () => {
		const user = userEvent.setup();
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		await act(async () =>
			answer({ ok: false, error: { code: "analysis_failed" } }),
		);
		const text = aiErrorText("fr", "analysis_failed");
		expect(await within(dialog).findByText(text)).toBeTruthy();
		// Ni dans la pastille, ni dans sa région annoncée : le panneau a sa propre alerte.
		expect(screen.getAllByText(text)).toHaveLength(1);
		// La dernière ligne d'état laisse place au vide (2 s plus tard), pas à l'erreur.
		await vi.waitFor(() => expect(announced()).toBe(""), { timeout: 3_000 });

		// Panneau fermé : l'erreur revient dans la pastille.
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(await screen.findAllByText(text)).not.toHaveLength(0);
	});

	test("connexion impossible depuis la pastille : le panneau s'ouvre avec le texte de repli", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		const fallback = contentText("fr", "ai.loginFallback");
		expect(await screen.findByText(fallback)).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();

		// Déjà su impossible : le panneau rouvre dès le clic.
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(identifyButton());
		expect(await screen.findByText(fallback)).toBeTruthy();
	});

	test("sans abonnement : un lien vers les formules, dans la langue active", () => {
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="nl"
				ai={ai}
				accessCache={cached({ status: "noSubscription" })}
			/>,
		);
		const link = screen.getByRole("link", { name: "Product identificeren" });
		expect(link.getAttribute("href")).toMatch(/\/pricing\/\?lang=nl$/);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(identifyControls("nl")).toHaveLength(1);
	});

	test("live line follows last event", async () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		fireEvent.click(launch());
		expect(statusLineEl()?.textContent).toBe("Démarrage de l'analyse");
		emit({ type: "stage", stage: "photos", count: 3 });
		expect(statusLineEl()?.textContent).toBe("Téléchargement de 3 photos");
		emit(searchEvent);
		expect(within(toggle()).getByText(SEARCH_LINE)).toBeTruthy();
		expect(statusLineEl()?.textContent).toBe(SEARCH_LINE);
		// Le nom du bouton ne change pas pendant l'analyse.
		expect(toggle().getAttribute("aria-label")).toBe(
			contentText("fr", "badge.aria"),
		);
	});

	test("waiting class after 4s", async () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		// Horloge simulée une fois la pastille identifiée (lecture du magasin faite).
		vi.useFakeTimers();
		fireEvent.click(launch());
		emit(searchEvent);
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(false);
		act(() => vi.advanceTimersByTime(3_999));
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(false);
		act(() => vi.advanceTimersByTime(1));
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(true);
		// La ligne garde le dernier texte.
		expect(statusLineEl()?.textContent).toBe(SEARCH_LINE);
		emit({ type: "stage", stage: "writing" });
		expect(statusLineEl()?.classList.contains("is-waiting")).toBe(false);
	});

	test("aria-live throttled to 2s", async () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		// Horloge simulée une fois la pastille identifiée (lecture du magasin faite).
		vi.useFakeTimers();
		expect(region().getAttribute("aria-live")).toBe("polite");
		expect(announced()).toBe("");
		fireEvent.click(launch());
		expect(announced()).toBe("Démarrage de l'analyse");
		emit({ type: "stage", stage: "photos", count: 3 });
		emit(searchEvent);
		// La ligne visible suit chaque événement ; la région annoncée attend.
		expect(statusLineEl()?.textContent).toBe(SEARCH_LINE);
		expect(announced()).toBe("Démarrage de l'analyse");
		act(() => vi.advanceTimersByTime(1_999));
		expect(announced()).toBe("Démarrage de l'analyse");
		act(() => vi.advanceTimersByTime(1));
		expect(announced()).toBe(SEARCH_LINE);
		act(() => vi.advanceTimersByTime(500));
		emit({ type: "stage", stage: "writing" });
		expect(announced()).toBe(SEARCH_LINE);
		act(() => vi.advanceTimersByTime(1_499));
		expect(announced()).toBe(SEARCH_LINE);
		act(() => vi.advanceTimersByTime(1));
		expect(announced()).toBe("Rédige le verdict");
	});

	test.each(["stream_interrupted", "timeout"])(
		"interrupted shows relaunch (%s)",
		async (code) => {
			const user = userEvent.setup();
			scanReply.mockResolvedValueOnce({ ok: false, error: { code } });
			await renderIdentified({ accessCache: cached(active) });
			await user.click(launch());
			expect(await screen.findByText(aiErrorText("fr", code))).toBeTruthy();
			// Jamais un logo qui tourne sans fin.
			expect(document.querySelector(".rq-logo--loading")).toBeNull();
			expect(queryLaunch()).toBeNull();
			expect(screen.queryByRole("dialog")).toBeNull();
			await user.click(screen.getByRole("button", { name: "Relancer" }));
			expect(ai.scan).toHaveBeenCalledTimes(2);
			await vi.waitFor(() => expect(toggle().textContent).toContain("55/100"));
		},
	);

	test("model text rendered as text", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		const { container } = await renderIdentified({
			accessCache: cached(active),
		});
		await user.click(launch());
		const text = "<img src=x onerror=alert(1)>";
		emit({ type: "thinking", part: 1, text });
		expect(container.querySelector("img")).toBeNull();
		expect(statusLineEl()?.textContent).toBe(text);
		// Le déroulé du panneau aussi.
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(text)).toBeTruthy();
		expect(container.querySelector("img")).toBeNull();
	});

	// Design de la pilule (verre sombre, logo, reflet de la ligne d'état).
	const logoOf = (element: Element) => element.querySelector("svg");

	test("au repos : le logo est présent, sans rq-logo--loading", () => {
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		const pill = identifyButton();
		const logo = logoOf(pill);
		expect(logo).not.toBeNull();
		expect(logo?.getAttribute("aria-hidden")).toBe("true");
		expect(logo?.getAttribute("width")).toBe("16");
		expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
		expect(pill.textContent).toBe(contentText("fr", "identify.launchShort"));
		// Verre sombre, Inter, anneau de focus au clavier.
		for (const name of [
			"h-7",
			"rounded-pill",
			"bg-glass-host",
			"supports-[backdrop-filter]:backdrop-blur-[18px]",
			"border-white/12",
			"shadow-[var(--shadow-pill)]",
			"font-sans",
			"text-[13px]",
			"font-medium",
			"text-text-1",
			"focus-visible:shadow-[var(--focus-ring)]",
		])
			expect(pill.classList.contains(name), name).toBe(true);
		// Plus aucune couleur Tailwind brute.
		expect(pill.className).not.toMatch(
			/slate-|white\b(?!\/)|red-|green-|amber-/,
		);
	});

	test("en cours : le logo porte rq-logo--loading et la ligne d'état rq-shimmer ; plus aucun radarnaque-spin", async () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		fireEvent.click(launch());
		emit(searchEvent);
		const logo = logoOf(toggle());
		expect(logo?.classList.contains("rq-logo--loading")).toBe(true);
		expect(logo?.querySelector(".rq-logo-spin .rq-logo-arc")).not.toBeNull();
		const text = statusLineEl()?.querySelector(".rq-shimmer");
		expect(text?.textContent).toBe(SEARCH_LINE);
		expect(document.querySelector(".radarnaque-spin")).toBeNull();
		expect(document.querySelector(".radarnaque-fade")).toBeNull();
	});

	test("résultat : point, niveau en toutes lettres, séparateur, score ; la couleur vient de LEVEL_STYLE (bg-danger pour high)", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: aiHigh });
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		await launchToResult(user, 82);
		const [dot, level, separator, score, ...rest] = Array.from(
			toggle().children,
		);
		expect(rest).toHaveLength(0);
		expect(dot?.getAttribute("aria-hidden")).toBe("true");
		expect(dot?.classList.contains("bg-danger")).toBe(true);
		expect(dot?.classList.contains("size-2")).toBe(true);
		expect(level?.textContent).toBe("Risque élevé");
		expect(separator?.getAttribute("aria-hidden")).toBe("true");
		expect(separator?.textContent).toBe("");
		expect(score?.textContent).toBe("82/100");
		expect(score?.classList.contains("text-text-2")).toBe(true);
		expect(score?.classList.contains("tabular-nums")).toBe(true);
		// Pas de logo qui tourne avec un résultat.
		expect(toggle().querySelector(".rq-logo--loading")).toBeNull();
	});

	test("erreur : logo sans animation et à 60 % d'opacité, message, « Relancer »", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		const message = await screen.findByText(
			aiErrorText("fr", "stream_interrupted"),
		);
		expect(message.classList.contains("text-text-2")).toBe(true);
		const relaunch = screen.getByRole("button", { name: "Relancer" });
		expect(relaunch.classList.contains("underline")).toBe(true);
		const pill = relaunch.parentElement as HTMLElement;
		expect(pill.contains(message)).toBe(true);
		expect(pill.classList.contains("bg-glass-host")).toBe(true);
		const logo = logoOf(pill);
		expect(logo?.classList.contains("rq-logo--loading")).toBe(false);
		expect(logo?.classList.contains("opacity-60")).toBe(true);
	});

	test("ligne d'état de 200 caractères : tronquée (classe truncate) dans une pilule bornée à 340 px", async () => {
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		fireEvent.click(launch());
		const query = "iPhone 18 Pro ".repeat(15).slice(0, 200);
		emit({ type: "search", id: 2, query, aspect: "price" });
		const pill = toggle();
		expect(pill.classList.contains("max-w-[340px]")).toBe(true);
		expect(pill.classList.contains("min-w-0")).toBe(true);
		const text = statusLineEl()?.querySelector(".rq-shimmer");
		// `statusLine` coupe déjà le texte ; la pilule le tronque encore à l'affichage.
		expect(text?.textContent).toMatch(
			/^Recherche web \(prix du marché\) : “iPhone 18 Pro/,
		);
		expect(text?.classList.contains("truncate")).toBe(true);
		expect(text?.classList.contains("min-w-0")).toBe(true);
		expect(statusLineEl()?.classList.contains("min-w-0")).toBe(true);
		// Le logo ne rétrécit pas : seul le texte est tronqué.
		expect(logoOf(pill)?.classList.contains("shrink-0")).toBe(true);
	});

	test("lancée au clavier, l'identification garde le focus sur la pilule, puis sur le produit", async () => {
		const user = userEvent.setup();
		let finish!: (value: BgResponse<IdentificationResult>) => void;
		identifyReply.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={cached(active)}
			/>,
		);
		const pill = identifyButton();
		pill.focus();
		await user.keyboard("{Enter}");
		expect(ai.identify).toHaveBeenCalledTimes(1);
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		// Le même élément passe du repos à l'identification en cours.
		expect(toggle()).toBe(pill);
		expect(document.activeElement).toBe(pill);
		await act(async () => finish({ ok: true, data: sampleIdentification }));
		// La pilule change d'élément : le focus passe à sa partie produit.
		expect(document.activeElement).toBe(product());
	});

	test("lancée au clavier depuis « Analyser le risque », l'analyse garde le focus sur la pilule", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		launch().focus();
		await user.keyboard("{Enter}");
		expect(ai.scan).toHaveBeenCalledTimes(1);
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		expect(document.activeElement).toBe(toggle());
	});

	test("lancée au clavier avec un accès inconnu : le focus reste sur la pilule une fois l'accès lu", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified();
		const pill = launch();
		pill.focus();
		await user.keyboard("{Enter}");
		await vi.waitFor(() =>
			expect(toggle().getAttribute("aria-busy")).toBe("true"),
		);
		expect(document.activeElement).toBe(toggle());
	});

	test("panneau ouvert après une erreur, accès relu à 0 : la pilule garde le logo atténué, jamais vide", async () => {
		const user = userEvent.setup();
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		const { container } = await renderIdentified({
			accessCache: cached(active),
		});
		await user.click(launch());
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		await act(async () =>
			answer({ ok: false, error: { code: "quota_exhausted" } }),
		);
		await vi.waitFor(() => expect(ai.access).toHaveBeenCalled());
		await vi.waitFor(() => expect(launchControls()).toHaveLength(0));
		expect(screen.queryByRole("button", { name: "Relancer" })).toBeNull();
		// Le texte de l'erreur reste dans le panneau seulement.
		expect(
			within(dialog).getByText(aiErrorText("fr", "quota_exhausted")),
		).toBeTruthy();
		// Hors du panneau : le logo atténué de la pilule seul.
		const logos = Array.from(container.querySelectorAll("svg")).filter(
			(svg) => !dialog.contains(svg),
		);
		expect(logos).toHaveLength(1);
		expect(logos[0]?.classList.contains("opacity-60")).toBe(true);
		expect(logos[0]?.closest(".bg-glass-host")).not.toBeNull();
	});
});

describe("RiskBadge : seule l'IA donne un résultat", () => {
	test("résultat repris du magasin : niveau et score affichés tout de suite, aucun scan, aucun « Identifier »", async () => {
		const user = userEvent.setup();
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: aiHigh,
				identification: null,
				identifiedByUser: false,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		const { container } = render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
				accessCache={cached(active)}
			/>,
		);
		// Premier rendu, magasin pas encore lu : aucun « Identifier » à cliquer, qui
		// lancerait une vraie requête (accès actif en cache) sur une fiche déjà analysée.
		expect(identifyControls()).toHaveLength(0);
		expect(container.textContent).not.toContain(
			contentText("fr", "identify.launchShort"),
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(toggle().textContent).toContain("Risque élevé");
		expect(described()).toEqual(["Risque élevé", "82/100"]);
		expect(identifyControls()).toHaveLength(0);
		expect(launchControls()).toHaveLength(0);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.textContent).toContain(aiHigh.summary.fr);
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("fiche sans résultat en magasin : « Identifier » apparaît une fois la lecture finie", async () => {
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={storeWith({})}
			/>,
		);
		expect(identifyControls()).toHaveLength(0);
		await vi.waitFor(() => expect(identifyControls()).toHaveLength(1));
		expect(identifyButton().textContent).toBe(
			contentText("fr", "identify.launchShort"),
		);
	});

	test("magasin dont la lecture échoue : « Identifier » apparaît, jamais une pastille vide", async () => {
		const failing: AiResultStore = {
			...storeWith({}),
			get: async () => {
				throw new Error("stockage indisponible");
			},
		};
		render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={failing}
			/>,
		);
		await vi.waitFor(() => expect(identifyControls()).toHaveLength(1));
		expect(ai.identify).not.toHaveBeenCalled();
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("I2 : résultat repris, puis prix changé sous la même clé : retour à « Identifier », sans score", async () => {
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: aiHigh,
				identification: null,
				identifiedByUser: false,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		const view = render(
			<RiskBadge
				report={medium}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		view.rerender(
			<RiskBadge
				report={medium}
				listing={{
					...listing,
					price: { amountCents: 9000, currency: "EUR" },
				}}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		expect(identifyControls()).toHaveLength(1);
		expect(launchControls()).toHaveLength(0);
		expect(view.container.textContent).not.toContain("/100");
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("restored analysis shows the risk result; restored identification shows the product and the action; v2 entry shows the risk result", async () => {
		const now = Date.parse("2026-10-23T11:00:00Z");
		const analysis: AnalysisResult = {
			...aiHigh,
			analyzedAt: "2026-10-23T10:00:00Z",
		};
		const of = (id: string): Listing => ({
			...listing,
			externalId: id,
			url: `https://www.2ememain.be/v/velo/${id}`,
		});
		const fingerprint = listingFingerprint(listing);
		const stored: Record<string, StoredAiEntry> = {
			// Analyse gardée (et son identification).
			"2ememain.be|analyse": {
				v: 3,
				result: analysis,
				identification: sampleIdentification,
				identifiedByUser: true,
				fingerprint,
				storedAt: now,
			},
			// Identification seule, faite par l'utilisateur.
			"2ememain.be|identification": {
				v: 3,
				result: null,
				identification: sampleIdentification,
				identifiedByUser: true,
				fingerprint,
				storedAt: now,
			},
			// Ancienne entrée `v: 2` : l'analyse seule, identification embarquée.
			"2ememain.be|v2": {
				v: 2,
				result: { ...analysis, identification: sampleIdentification },
				fingerprint,
				storedAt: now,
			} as unknown as StoredAiEntry,
		};
		const area: StorageAreaLike = {
			getValue: async () => stored,
			setValue: async () => {},
		};
		const aiResults = createAiResultStore(area, () => now);
		const view = render(
			<RiskBadge
				report={medium}
				listing={of("analyse")}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(identifyControls()).toHaveLength(0);
		expect(launchControls()).toHaveLength(0);
		expect(screen.queryByRole("button", { name: SURE })).toBeNull();

		view.rerender(
			<RiskBadge
				report={medium}
				listing={of("identification")}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		await findLaunch();
		expect(product().getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("button", { name: /Radarnaque/ })).toBeNull();
		expect(view.container.textContent).not.toContain("/100");
		expect(identifyControls()).toHaveLength(0);

		view.rerender(
			<RiskBadge
				report={medium}
				listing={of("v2")}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
			/>,
		);
		await vi.waitFor(() => expect(toggle().textContent).toContain("82/100"));
		expect(launchControls()).toHaveLength(0);
		expect(identifyControls()).toHaveLength(0);
		expect(ai.identify).not.toHaveBeenCalled();
		expect(ai.scan).not.toHaveBeenCalled();
	});
});

describe("RiskBadge : section Debug (superuser)", () => {
	const superuser: ContentAccess = { ...active, unlimited: true, debug: true };
	const debugTitle = contentText("fr", "debug.title");
	/** Analyse lancée depuis la pilule, puis panneau ouvert sur son résultat. */
	const openResult = async (user: ReturnType<typeof userEvent.setup>) => {
		await launchToResult(user);
		await user.click(toggle());
	};

	test("résultat sans debug : aucune section Debug", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(sampleAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
	});

	test("debug reçu mais accès sans debug (compte ordinaire) : aucune section", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
	});

	test("superuser, résultat avec debug : section en bas du panneau, modèle et prompt", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		const summary = await screen.findByText(debugTitle);
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("fournisseur-test / modele-test");
		expect(dialog.textContent).toContain("full v1");
		expect(dialog.textContent).toContain(sampleDebug.systemPrompt);
		// En bas du panneau, après le résultat IA.
		expect(dialog.lastElementChild).toBe(summary.closest("details"));
	});

	test("« Relancer sans cache » : noCache: true, résultat gardé pendant la relance, puis remplacé", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValueOnce({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugTitle);

		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		);
		expect(ai.scan).toHaveBeenCalledTimes(2);
		expect(ai.scan.mock.calls[1]?.[0]).toEqual({
			...ai.scan.mock.calls[0]?.[0],
			noCache: true,
		});
		// Pendant la relance : le résultat reste, seul le bouton indique le chargement.
		expect(screen.getByText(debugAnalysis.summary.fr)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: contentText("fr", "ai.loading") }),
		).toBeTruthy();
		expect(toggle().textContent).toContain(`${debugAnalysis.score}/100`);

		const fresh: AnalysisResult = {
			...debugAnalysis,
			score: 91,
			summary: { fr: "Nouveau verdict.", nl: "Nieuw oordeel." },
			debug: { ...sampleDebug, fromCache: false, model: "modele-2" },
		};
		await act(async () => answer({ ok: true, data: fresh }));
		expect(screen.getByText("Nouveau verdict.")).toBeTruthy();
		expect(screen.queryByText(debugAnalysis.summary.fr)).toBeNull();
		expect(screen.getByRole("dialog").textContent).toContain("modele-2");
		expect(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		).toBeTruthy();
	});

	test("relance en erreur : le verdict reste, l'erreur s'affiche dans la section Debug", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply
			.mockResolvedValueOnce({ ok: true, data: debugAnalysis })
			.mockResolvedValueOnce({ ok: false, error: { code: "rate_limited" } });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugTitle);
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.rescan") }),
		);
		expect((await screen.findByRole("alert")).textContent).toBe(
			aiErrorText("fr", "rate_limited"),
		);
		expect(screen.getByText(debugAnalysis.summary.fr)).toBeTruthy();
		expect(screen.getByText(debugTitle)).toBeTruthy();
	});

	test("debug malformé : la section Debug disparaît seule, le verdict IA reste", async () => {
		const user = userEvent.setup();
		vi.spyOn(console, "error").mockImplementation(() => {});
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		const broken = {
			...debugAnalysis,
			debug: { ...sampleDebug, messages: null },
		} as unknown as AnalysisResult;
		scanReply.mockResolvedValue({ ok: true, data: broken });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugAnalysis.summary.fr);
		expect(screen.queryByText(debugTitle)).toBeNull();
		// Pas l'erreur générique de la section IA : seul le debug est masqué.
		expect(screen.queryByText(aiErrorText("fr", "default"))).toBeNull();
		expect(toggle().textContent).toContain(`${debugAnalysis.score}/100`);
	});

	test("« Copier » écrit le JSON du debug dans le presse-papiers", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: superuser });
		scanReply.mockResolvedValue({ ok: true, data: debugAnalysis });
		render(<RiskBadge report={low} listing={listing} locale="fr" ai={ai} />);
		await openResult(user);
		await screen.findByText(debugTitle);
		const writeText = vi.spyOn(navigator.clipboard, "writeText");
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "debug.copy") }),
		);
		expect(writeText).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify(sampleDebug, null, 2),
		);
		expect(
			await screen.findByRole("button", {
				name: contentText("fr", "debug.copied"),
			}),
		).toBeTruthy();
	});
});

describe("RiskBadge : bandeau des annonces professionnelles", () => {
	const pro: Listing = {
		...listing,
		seller: { ...listing.seller, sellerKind: "professional" },
	};
	/** Sans abonnement, accès inconnu : le clic sur « Identifier » ouvre le panneau. */
	const openAtRest = async (
		user: ReturnType<typeof userEvent.setup>,
		locale: "fr" | "nl" = "fr",
	) => {
		ai.access.mockResolvedValue({
			ok: true,
			data: { status: "noSubscription" },
		});
		await user.click(
			screen.getByRole("button", {
				name: contentText(locale, "identify.launch"),
			}),
		);
		return screen.findByRole("dialog");
	};

	test("vendeur professionnel au repos : le bandeau est en tête du panneau ouvert, sans score local", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<RiskBadge report={medium} listing={pro} locale="fr" ai={ai} />,
		);
		const dialog = await openAtRest(user);
		const note = within(dialog).getByRole("note");
		expect(note.textContent).toBe(contentText("fr", "pro.notice"));
		// En tête du panneau, juste sous son en-tête, au-dessus de tout le reste.
		expect(dialog.firstElementChild?.nextElementSibling).toBe(note);
		expect(note.className).toContain("bg-info-soft");
		expect(note.className).not.toMatch(/\bslate-/);
		expect(container.textContent).not.toContain("40/100");
		expect(container.textContent).not.toContain("Risque moyen");
		for (const text of LOCAL_TEXTS)
			expect(dialog.textContent).not.toContain(text);
	});

	test("en NL : texte NL du bandeau", async () => {
		const user = userEvent.setup();
		render(<RiskBadge report={medium} listing={pro} locale="nl" ai={ai} />);
		const dialog = await openAtRest(user, "nl");
		expect(within(dialog).getByRole("note").textContent).toBe(
			contentText("nl", "pro.notice"),
		);
	});

	test("vendeur particulier sans détection IA : pas de bandeau", async () => {
		const user = userEvent.setup();
		const priv: Listing = {
			...listing,
			seller: { ...listing.seller, sellerKind: "private" },
		};
		render(<RiskBadge report={medium} listing={priv} locale="fr" ai={ai} />);
		await openAtRest(user);
		expect(screen.queryByRole("note")).toBeNull();
	});

	test("IA professional: true, score 75 : le bandeau et « 75/100 » sont tous deux présents", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValue({
			ok: true,
			data: { ...sampleAnalysis, professional: true, level: "high", score: 75 },
		});
		render(<RiskBadge report={medium} listing={listing} locale="fr" ai={ai} />);
		await launchToResult(user, 75);
		await user.click(toggle());
		const note = within(screen.getByRole("dialog")).getByRole("note");
		expect(note.textContent).toBe(contentText("fr", "pro.notice"));
		expect(toggle().textContent).toContain("Risque élevé");
		expect(screen.getByRole("dialog").textContent).toContain("75/100");
	});
});

describe("RiskBadge : focus clavier", () => {
	const RETRY = contentText("fr", "ai.retry");
	const retry = () => screen.getByRole("button", { name: RETRY });
	/**
	 * Pastille identifiée (« Analyser le risque » affiché) avec accès actif en
	 * cache, et un bouton de la page hôte à côté.
	 */
	const renderWithPage = () =>
		renderIdentified({ accessCache: cached(active), page: true });
	/** Analyse suivie à la main : `answer` la termine. */
	const pendingScan = () => {
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		return (value: BgResponse<AnalysisResult>) =>
			act(async () => answer(value));
	};

	test("Échap, focus dans le panneau : le focus revient à la pilule", async () => {
		const user = userEvent.setup();
		await renderWithPage();
		await launchToResult(user);
		await user.click(toggle());
		screen.getByRole("button", { name: PANEL_CLOSE }).focus();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(toggle());
	});

	test("Échap, focus sur la page hôte : le panneau se ferme sans lui voler le focus", async () => {
		const user = userEvent.setup();
		await renderWithPage();
		await launchToResult(user);
		await user.click(toggle());
		const page = screen.getByRole("button", { name: "page" });
		page.focus();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(page);
	});

	test("dans un Shadow DOM : Échap, focus dans le panneau, le focus revient à la pilule", async () => {
		const user = userEvent.setup();
		const host = document.createElement("div");
		document.body.append(host);
		const shadow = host.attachShadow({ mode: "open" });
		const container = document.createElement("div");
		shadow.append(container);
		const view = render(
			<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />,
			{ container },
		);
		await user.click(within(container).getByRole("button", { name: IDENTIFY }));
		await user.click(
			await within(container).findByRole("button", { name: LAUNCH }),
		);
		const pill = await within(container).findByRole("button", {
			name: /Radarnaque/,
		});
		await vi.waitFor(() => expect(pill.textContent).toContain("/100"));
		await user.click(pill);
		within(container).getByRole("button", { name: PANEL_CLOSE }).focus();
		await user.keyboard("{Escape}");
		expect(within(container).queryByRole("dialog")).toBeNull();
		expect(shadow.activeElement).toBe(
			within(container).getByRole("button", { name: /Radarnaque/ }),
		);
		view.unmount();
		host.remove();
	});

	test("analyse lancée au clavier puis interrompue : le focus passe à « Relancer »", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderWithPage();
		launch().focus();
		await user.keyboard("{Enter}");
		expect(document.activeElement).toBe(toggle());
		await finish({ ok: false, error: { code: "stream_interrupted" } });
		expect(document.activeElement).toBe(retry());
	});

	test("analyse lancée au clavier puis en échec : le focus passe à « Analyser le risque » de la pilule d'erreur", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderWithPage();
		launch().focus();
		await user.keyboard("{Enter}");
		await finish({ ok: false, error: { code: "analysis_failed" } });
		expect(screen.getByText(aiErrorText("fr", "analysis_failed"))).toBeTruthy();
		expect(document.activeElement).toBe(launch());
	});

	test("« Relancer » au clavier : le focus passe à la pilule de l'analyse en cours, puis du résultat", async () => {
		const user = userEvent.setup();
		const first = pendingScan();
		await renderWithPage();
		launch().focus();
		await user.keyboard("{Enter}");
		await first({ ok: false, error: { code: "timeout" } });
		const second = pendingScan();
		retry().focus();
		await user.keyboard("{Enter}");
		expect(ai.scan).toHaveBeenCalledTimes(2);
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		expect(document.activeElement).toBe(toggle());
		await second({ ok: true, data: aiHigh });
		expect(toggle().textContent).toContain("82/100");
		expect(document.activeElement).toBe(toggle());
	});

	test("échec arrivé alors que le focus est sur la page hôte : il y reste", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderWithPage();
		launch().focus();
		await user.keyboard("{Enter}");
		const page = screen.getByRole("button", { name: "page" });
		page.focus();
		await finish({ ok: false, error: { code: "stream_interrupted" } });
		expect(retry()).toBeTruthy();
		expect(document.activeElement).toBe(page);
	});

	test("lancée au clavier, quota relu à 0 après l'échec : le focus reste sur la pilule d'erreur, hors de l'ordre de tabulation", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderWithPage();
		launch().focus();
		await user.keyboard("{Enter}");
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		await finish({ ok: false, error: { code: "quota_exhausted" } });
		await vi.waitFor(() => expect(queryLaunch()).toBeNull());
		const message = screen.getByText(aiErrorText("fr", "quota_exhausted"));
		const pill = message.parentElement as HTMLElement;
		expect(pill.getAttribute("tabindex")).toBe("-1");
		expect(document.activeElement).toBe(pill);
	});

	test("panneau ouvert, erreur sans action (quota relu à 0) : « Fermer » rend le focus à la pilule réduite au logo", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderWithPage();
		await user.click(launch());
		await user.click(toggle());
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { ...active, remaining: { scans: 0 } },
		}));
		await finish({ ok: false, error: { code: "quota_exhausted" } });
		const dialog = screen.getByRole("dialog");
		expect(
			await within(dialog).findByText(aiErrorText("fr", "quota_exhausted")),
		).toBeTruthy();
		await vi.waitFor(() => expect(queryLaunch()).toBeNull());
		// Pilule réduite au logo : ni message (dans le panneau), ni action. Son
		// conteneur précède la seule région annoncée.
		const pill = screen.getByRole("status").previousElementSibling
			?.firstElementChild as HTMLElement | undefined;
		expect(pill?.textContent).toBe("");
		expect(pill?.getAttribute("tabindex")).toBe("-1");
		await user.click(within(dialog).getByRole("button", { name: PANEL_CLOSE }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByText(aiErrorText("fr", "quota_exhausted")).parentElement,
		);
	});

	/**
	 * Comme Chromium (`RemoveFocusedElementOfSubtree`) : avant de retirer un nœud
	 * qui contient l'élément focalisé, `blur` puis `focusout` (qui remonte), sans
	 * `relatedTarget`, émis sur l'élément encore dans le DOM. happy-dom, comme
	 * Firefox, n'émet rien. React retire ses nœuds par `removeChild` : l'espion
	 * l'enveloppe et compte les suppressions simulées, pour que chaque test
	 * vérifie que le cas Chrome a bien eu lieu.
	 */
	const removalLikeChrome = () => {
		const removeChild = Node.prototype.removeChild;
		let blurred = 0;
		const spy = vi
			.spyOn(Node.prototype, "removeChild")
			.mockImplementation(function <T extends Node>(this: Node, child: T): T {
				let focused = document.activeElement;
				while (focused?.shadowRoot?.activeElement)
					focused = focused.shadowRoot.activeElement;
				if (focused && focused !== document.body && child.contains(focused)) {
					blurred += 1;
					focused.dispatchEvent(
						new FocusEvent("blur", { relatedTarget: null }),
					);
					focused.dispatchEvent(
						new FocusEvent("focusout", {
							bubbles: true,
							composed: true,
							relatedTarget: null,
						}),
					);
				}
				return removeChild.call(this, child) as T;
			});
		return {
			blurred: () => blurred,
			restore: () => spy.mockRestore(),
		};
	};

	describe("comme Chrome : blur et focusout émis à la suppression du nœud focalisé", () => {
		let chrome: ReturnType<typeof removalLikeChrome>;
		beforeEach(() => {
			chrome = removalLikeChrome();
		});
		afterEach(() => chrome.restore());

		test("analyse lancée au clavier puis interrompue : le focus passe à « Relancer »", async () => {
			const user = userEvent.setup();
			const finish = pendingScan();
			await renderWithPage();
			launch().focus();
			await user.keyboard("{Enter}");
			expect(document.activeElement).toBe(toggle());
			await finish({ ok: false, error: { code: "stream_interrupted" } });
			// L'action retirée au départ de l'analyse, puis la pilule en cours.
			expect(chrome.blurred()).toBe(2);
			expect(document.activeElement).toBe(retry());
		});

		test("analyse lancée au clavier puis en échec : le focus passe à « Analyser le risque » de la pilule d'erreur", async () => {
			const user = userEvent.setup();
			const finish = pendingScan();
			await renderWithPage();
			launch().focus();
			await user.keyboard("{Enter}");
			await finish({ ok: false, error: { code: "analysis_failed" } });
			expect(chrome.blurred()).toBe(2);
			expect(document.activeElement).toBe(launch());
		});

		test("« Relancer » au clavier : le focus passe à la pilule de l'analyse en cours, puis du résultat", async () => {
			const user = userEvent.setup();
			const first = pendingScan();
			await renderWithPage();
			launch().focus();
			await user.keyboard("{Enter}");
			await first({ ok: false, error: { code: "timeout" } });
			// Focus remis à la main : ce test ne vérifie que le passage suivant.
			retry().focus();
			const second = pendingScan();
			await user.keyboard("{Enter}");
			expect(chrome.blurred()).toBe(3);
			expect(toggle().getAttribute("aria-busy")).toBe("true");
			expect(document.activeElement).toBe(toggle());
			await second({ ok: true, data: aiHigh });
			expect(toggle().textContent).toContain("82/100");
			expect(document.activeElement).toBe(toggle());
		});

		test("dans un Shadow DOM : analyse interrompue, le focus passe à « Relancer »", async () => {
			const user = userEvent.setup();
			const finish = pendingScan();
			const host = document.createElement("div");
			document.body.append(host);
			const shadow = host.attachShadow({ mode: "open" });
			const container = document.createElement("div");
			shadow.append(container);
			const view = render(
				<RiskBadge
					report={high}
					listing={listing}
					locale="fr"
					ai={ai}
					accessCache={cached(active)}
					aiResults={storeWith(identifiedEntry())}
				/>,
				{ container },
			);
			(await within(container).findByRole("button", { name: LAUNCH })).focus();
			await user.keyboard("{Enter}");
			await finish({ ok: false, error: { code: "stream_interrupted" } });
			expect(chrome.blurred()).toBe(2);
			expect(shadow.activeElement).toBe(
				within(container).getByRole("button", { name: RETRY }),
			);
			view.unmount();
			host.remove();
		});

		test("fenêtre quittée pendant l'analyse (focusout sans relatedTarget, pilule toujours là) : le focus n'est pas repris à l'échec", async () => {
			const user = userEvent.setup();
			const finish = pendingScan();
			await renderWithPage();
			launch().focus();
			await user.keyboard("{Enter}");
			const pill = toggle();
			// L'utilisateur passe à une autre fenêtre : Chrome émet blur et focusout
			// sur la pilule, qui reste dans le DOM et reste l'élément actif.
			pill.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
			pill.dispatchEvent(
				new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
			);
			window.dispatchEvent(new FocusEvent("blur"));
			// Fenêtre sans focus : Chrome n'émet plus rien à la suppression.
			chrome.restore();
			await finish({ ok: false, error: { code: "stream_interrupted" } });
			expect(pill.isConnected).toBe(false);
			expect(document.activeElement).toBe(document.body);
		});

		test("focus quitté vers `body` (pilule toujours là) puis rendu dans la même tâche : le focus n'est pas repris", async () => {
			const user = userEvent.setup();
			await renderWithPage();
			await launchToResult(user);
			const pill = toggle();
			pill.focus();
			// Clic sur un fond de page non focalisable : focusout sans relatedTarget,
			// focus sur `body`, et un rendu avant la micro-tâche suivante.
			act(() => {
				pill.blur();
				fireEvent.click(pill);
			});
			expect(screen.getByRole("dialog")).toBeTruthy();
			expect(pill.isConnected).toBe(true);
			expect(document.activeElement).toBe(document.body);
		});
	});

	test("pilule d'erreur avec une action : pas de tabindex sur la pilule", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderWithPage();
		await user.click(launch());
		await finish({ ok: false, error: { code: "stream_interrupted" } });
		expect(retry().parentElement?.hasAttribute("tabindex")).toBe(false);
	});

	test("le panneau est nommé par son titre (aria-labelledby), sans aria-label", async () => {
		const user = userEvent.setup();
		await renderWithPage();
		await launchToResult(user);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog", {
			name: contentText("fr", "panel.title"),
		});
		expect(dialog.hasAttribute("aria-label")).toBe(false);
		const heading = within(dialog).getByRole("heading", { level: 2 });
		expect(heading.id).not.toBe("");
		expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
	});
});

describe("RiskBadge : une seule pilule, identification puis risque", () => {
	const aiDialog = () =>
		screen.queryByRole("dialog", { name: contentText("fr", "panel.title") });
	const renderActive = (locale: "fr" | "nl" = "fr") =>
		render(
			<div>
				<button type="button">page</button>
				<RiskBadge
					report={high}
					listing={listing}
					locale={locale}
					ai={ai}
					accessCache={cached(active)}
				/>
			</div>,
		);
	/** Identification suivie à la main : `answer` la termine. */
	const pendingIdentify = () => {
		let answer!: (value: BgResponse<IdentificationResult>) => void;
		identifyReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		return (value: BgResponse<IdentificationResult>) =>
			act(async () => answer(value));
	};
	/** Analyse suivie à la main : `answer` la termine. */
	const pendingScan = () => {
		let answer!: (value: BgResponse<AnalysisResult>) => void;
		scanReply.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		return (value: BgResponse<AnalysisResult>) =>
			act(async () => answer(value));
	};
	/** Événement du flux de l'identification lancée en dernier. */
	const emitIdentify = (e: ScanProgressEvent) => {
		const onEvent = ai.identify.mock.calls.at(-1)?.[1];
		if (!onEvent) throw new Error("aucune identification lancée");
		act(() => onEvent(e));
	};
	/** Événement du flux de l'analyse lancée en dernier. */
	const emitScan = (e: ScanProgressEvent) => {
		const onEvent = ai.scan.mock.calls.at(-1)?.[1];
		if (!onEvent) throw new Error("aucune analyse lancée");
		act(() => onEvent(e));
	};
	const lineOf = (pill: HTMLElement) =>
		pill.querySelector(".radarnaque-status .rq-shimmer")?.textContent;
	/** Jamais « Identifier » dans la pilule (bouton ou lien). */
	const noIdentify = () => expect(identifyControls()).toHaveLength(0);
	const { debug: _debug, ...flatIdentification } = sampleIdentification;
	const identificationEvent: ScanProgressEvent = {
		...flatIdentification,
		type: "identification",
	};

	test.each([
		[
			"fr",
			"Lecture des photos",
			"Identification : Steam Deck OLED · Sûr",
			"Steam Deck OLED·Démarrage de l'analyse",
			"Risque élevé82/100",
		],
		[
			"nl",
			"Foto's lezen",
			"Identificatie: Steam Deck OLED · Zeker",
			"Steam Deck OLED·Analyse wordt gestart",
			"Hoog risico82/100",
		],
	] as const)(
		"%s : parcours complet, repos → identification → produit → « Analyser le risque » → résultat",
		async (locale, line, name, analyzing, result) => {
			const user = userEvent.setup();
			const answerIdentify = pendingIdentify();
			const answerScan = pendingScan();
			renderActive(locale);
			// Repos : « Identifier ».
			await user.click(
				screen.getByRole("button", {
					name: contentText(locale, "identify.launch"),
				}),
			);
			expect(ai.identify).toHaveBeenCalledTimes(1);
			expect(ai.scan).not.toHaveBeenCalled();
			expect(screen.queryByRole("dialog")).toBeNull();
			// Identification en cours : le logo animé et sa ligne d'état.
			emitIdentify({ type: "stage", stage: "reading_photos" });
			expect(toggle().getAttribute("aria-busy")).toBe("true");
			expect(lineOf(toggle())).toBe(line);
			// Produit identifié : le produit, puis « Analyser le risque ».
			await answerIdentify({ ok: true, data: sampleIdentification });
			const productPart = screen.getByRole("button", { name });
			expect(productPart.getAttribute("aria-expanded")).toBe("false");
			const action = screen.getByRole("button", {
				name: contentText(locale, "ai.analyzeRisk"),
			});
			expect(ai.scan).not.toHaveBeenCalled();
			// Analyse du risque en cours : « Steam Deck OLED · {ligne d'état} ».
			await user.click(action);
			expect(ai.scan).toHaveBeenCalledTimes(1);
			expect(ai.identify).toHaveBeenCalledTimes(1);
			expect(toggle().getAttribute("aria-busy")).toBe("true");
			expect(toggle().textContent).toBe(analyzing);
			// Résultat : la pilule d'aujourd'hui.
			await answerScan({ ok: true, data: aiHigh });
			expect(toggle().textContent).toBe(result);
			expect(screen.queryByRole("button", { name })).toBeNull();
			expect(screen.getAllByRole("status")).toHaveLength(1);
		},
	);

	test("une seule région aria-live, à chaque étape", async () => {
		const user = userEvent.setup();
		const answerIdentify = pendingIdentify();
		const answerScan = pendingScan();
		const { container } = renderActive();
		const regions = () => container.querySelectorAll("[aria-live]");
		expect(regions()).toHaveLength(1);
		await user.click(identifyButton());
		expect(regions()).toHaveLength(1);
		await answerIdentify({ ok: true, data: sampleIdentification });
		expect(regions()).toHaveLength(1);
		await user.click(launch());
		expect(regions()).toHaveLength(1);
		await answerScan({ ok: true, data: aiHigh });
		expect(regions()).toHaveLength(1);
		// Une seule pilule.
		expect(container.querySelectorAll("[data-pill]")).toHaveLength(1);
	});

	test("focus gardé sur la pilule à chaque changement : repos → en cours → produit → action → en cours → résultat", async () => {
		const user = userEvent.setup();
		const answerIdentify = pendingIdentify();
		const answerScan = pendingScan();
		renderActive();
		identifyButton().focus();
		await user.keyboard("{Enter}");
		expect(document.activeElement).toBe(toggle());
		await answerIdentify({ ok: true, data: sampleIdentification });
		expect(document.activeElement).toBe(product());
		await user.tab();
		expect(document.activeElement).toBe(launch());
		await user.keyboard("{Enter}");
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		expect(document.activeElement).toBe(toggle());
		await answerScan({ ok: true, data: aiHigh });
		expect(toggle().textContent).toContain("82/100");
		expect(document.activeElement).toBe(toggle());
	});

	test("la partie produit ouvre et ferme le panneau ; l'action ne l'ouvre pas", async () => {
		const user = userEvent.setup();
		scanReply.mockImplementation(() => new Promise(() => {}));
		await renderIdentified({ accessCache: cached(active) });
		await user.click(product());
		expect(aiDialog()).not.toBeNull();
		expect(product().getAttribute("aria-expanded")).toBe("true");
		await user.click(product());
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(launch());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});

	test("Escape et « Fermer » rendent le focus à la partie produit ; clic extérieur ferme", async () => {
		const user = userEvent.setup();
		await renderIdentified({ accessCache: cached(active), page: true });
		await user.click(product());
		const dialog = aiDialog() as HTMLElement;
		within(dialog).getByRole("button", { name: PANEL_CLOSE }).focus();
		await user.keyboard("{Escape}");
		expect(aiDialog()).toBeNull();
		expect(document.activeElement).toBe(product());
		await user.click(product());
		await user.click(
			within(aiDialog() as HTMLElement).getByRole("button", {
				name: PANEL_CLOSE,
			}),
		);
		expect(aiDialog()).toBeNull();
		expect(document.activeElement).toBe(product());
		await user.click(product());
		await user.click(screen.getByRole("button", { name: "page" }));
		expect(aiDialog()).toBeNull();
	});

	test("panneau après l'identification : « Analyse Radarnaque », la section Produit puis « Analyser le risque »", async () => {
		const user = userEvent.setup();
		renderActive();
		await identifyFirst(user);
		await user.click(product());
		const dialog = aiDialog() as HTMLElement;
		const heading = within(dialog).getByRole("heading", { level: 2 });
		expect(heading.textContent).toBe("Analyse Radarnaque");
		expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
		// Le résultat : la référence, le niveau et le pourcentage.
		expect(dialog.textContent).toContain("Steam Deck OLED");
		expect(dialog.textContent).toContain("Sûr");
		expect(dialog.textContent).toContain("95 %");
		// Une seule section (le produit), sous son en-tête « Produit ».
		const regions = within(dialog).getAllByRole("region");
		expect(regions).toHaveLength(1);
		const [label, region] = within(dialog).getAllByRole("heading", {
			level: 3,
		});
		expect(label?.textContent).toBe(contentText("fr", "identify.product"));
		expect(label?.className).toContain("uppercase");
		expect(region?.textContent).toBe(contentText("fr", "identify.title"));
		// Puis le bouton pleine largeur, sans l'ancien bouton d'analyse.
		const action = within(dialog).getByRole("button", { name: LAUNCH });
		expect(action.className).toContain("w-full");
		expect(
			(label as HTMLElement).compareDocumentPosition(action) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// Aucune couleur sémantique du risque avant l'analyse.
		for (const element of Array.from(dialog.querySelectorAll("*")))
			expect(element.getAttribute("class") ?? "").not.toMatch(
				/(^|\s)(text|bg)-(danger|warning|success)(-soft)?(\s|$)/,
			);
	});

	test.each([
		["fr", "Produit", "Analyser le risque"],
		["nl", "Product", "Risico analyseren"],
	] as const)(
		"%s : « Analyser le risque » du panneau passe par le même chemin que la pilule",
		async (locale, label, action) => {
			const user = userEvent.setup();
			renderActive(locale);
			await user.click(
				screen.getByRole("button", {
					name: contentText(locale, "identify.launch"),
				}),
			);
			const pillPart = await screen.findByRole("button", {
				name: /Steam Deck OLED/,
			});
			await user.click(pillPart);
			const dialog = screen.getByRole("dialog");
			expect(
				within(dialog).getAllByRole("heading", { level: 3 })[0]?.textContent,
			).toBe(label);
			await user.click(within(dialog).getByRole("button", { name: action }));
			expect(ai.scan).toHaveBeenCalledTimes(1);
			expect(ai.identify).toHaveBeenCalledTimes(1);
		},
	);

	test("accès connecté, un seul pied « Analyses restantes » avant et après l'analyse du risque", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		renderActive();
		await identifyFirst(user);
		await user.click(product());
		const dialog = aiDialog() as HTMLElement;
		const remaining = (count: number) =>
			contentText("fr", "ai.remaining").replace("{count}", String(count));
		const footers = () =>
			(dialog.textContent ?? "").split("Analyses restantes").length - 1;
		expect(footers()).toBe(1);
		await user.click(within(dialog).getByRole("button", { name: LAUNCH }));
		await finish({ ok: true, data: aiHigh });
		expect(within(dialog).getByText(remaining(aiHigh.remaining.scans ?? 0)));
		// Le détail replié répète le produit, pas le pied.
		expect(footers()).toBe(1);
	});

	test.each([
		["fr", "Détail du produit"],
		["nl", "Productdetails"],
	] as const)(
		"%s : après l'analyse, le risque puis « %s », replié, qui s'ouvre au clic et montre le produit",
		async (locale, summaryText) => {
			const user = userEvent.setup();
			const finish = pendingScan();
			renderActive(locale);
			await user.click(
				screen.getByRole("button", {
					name: contentText(locale, "identify.launch"),
				}),
			);
			await user.click(
				await screen.findByRole("button", { name: /Steam Deck OLED/ }),
			);
			const dialog = screen.getByRole("dialog");
			await user.click(
				within(dialog).getByRole("button", {
					name: contentText(locale, "ai.analyzeRisk"),
				}),
			);
			await finish({ ok: true, data: aiHigh });
			// Le risque d'abord, l'ancien bouton d'analyse a disparu.
			expect(dialog.textContent).toContain("82");
			expect(
				within(dialog).queryByRole("button", {
					name: contentText(locale, "ai.analyzeRisk"),
				}),
			).toBeNull();
			const details = dialog.querySelector("details") as HTMLDetailsElement;
			const summary = details.querySelector("summary") as HTMLElement;
			expect(summary.textContent).toContain(summaryText);
			expect(details.open).toBe(false);
			// Après le résumé « Produit : … » du risque, dans l'ordre du DOM.
			const verdict = dialog.querySelector("[data-verdict]") as HTMLElement;
			expect(
				verdict.compareDocumentPosition(details) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			await user.click(summary);
			expect(details.open).toBe(true);
			expect(
				within(details).getAllByRole("heading", { level: 3 })[0]?.textContent,
			).toBe(contentText(locale, "identify.title"));
			expect(details.textContent).toContain("Steam Deck OLED");
		},
	);

	test("accès déconnecté après l'identification : l'écran de connexion n'apparaît qu'une fois", async () => {
		const user = userEvent.setup();
		ai.access.mockImplementation(async () => ({
			ok: true,
			data: { status: "signedOut" },
		}));
		const aiResults = storeWith(identifiedEntry());
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
				accessCache={cached({ status: "signedOut" })}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: SURE }));
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getAllByText(contentText("fr", "ai.loginHint")),
		).toHaveLength(1);
		expect(
			within(dialog).getAllByRole("button", {
				name: contentText("fr", "ai.login"),
			}),
		).toHaveLength(1);
	});

	test("0 analyse restante sans inclusion : le bouton du panneau est grisé, avec sa raison, et ne lance rien", async () => {
		const user = userEvent.setup();
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: { ...sampleAnalysis, partial: true },
				identification: sampleIdentification,
				identifiedByUser: false,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
				accessCache={cached({ ...active, remaining: { scans: 0 } })}
			/>,
		);
		await findLaunch();
		await user.click(await screen.findByRole("button", { name: SURE }));
		const action = within(screen.getByRole("dialog")).getByRole("button", {
			name: LAUNCH,
		});
		expect(action.getAttribute("aria-disabled")).toBe("true");
		expect(
			(action.getAttribute("aria-describedby") ?? "")
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent),
		).toEqual([contentText("fr", "ai.noScansLeft")]);
		await user.click(action);
		expect(ai.scan).not.toHaveBeenCalled();
	});

	test("à 0 analyse restante, l'analyse incluse part depuis le panneau", async () => {
		const user = userEvent.setup();
		await renderIdentified({
			accessCache: cached({ ...active, remaining: { scans: 0 } }),
		});
		await user.click(product());
		const action = within(screen.getByRole("dialog")).getByRole("button", {
			name: LAUNCH,
		});
		expect(action.hasAttribute("aria-disabled")).toBe(false);
		expect(
			(action.getAttribute("aria-describedby") ?? "")
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent),
		).toEqual([contentText("fr", "identify.included")]);
		await user.click(action);
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("sans abonnement : le panneau montre le lien vers les formules, une seule fois", async () => {
		const user = userEvent.setup();
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={storeWith(identifiedEntry())}
				accessCache={cached({ status: "noSubscription" })}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: SURE }));
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getAllByRole("link", {
				name: contentText("fr", "ai.pricing"),
			}),
		).toHaveLength(1);
		expect(within(dialog).queryByRole("button", { name: LAUNCH })).toBeNull();
	});

	test("erreur d'analyse sans identification (annonce modifiée) : le panneau relance par le même bouton, sans ancien chemin", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "analysis_failed" },
		});
		const accessCache = cached(active);
		const view = await renderIdentified({ accessCache });
		await user.click(product());
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: LAUNCH }),
		);
		await vi.waitFor(() => expect(ai.scan).toHaveBeenCalledTimes(1));
		await within(screen.getByRole("dialog")).findByText(
			aiErrorText("fr", "analysis_failed"),
		);
		// Nouvelle version de l'annonce : l'identification est abandonnée, l'erreur reste.
		view.rerender(
			<RiskBadge
				report={high}
				listing={{ ...listing, title: "Vélo (prix baissé)" }}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
				aiResults={storeWith(identifiedEntry())}
			/>,
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).queryByText("Détail du produit")).toBeNull();
		expect(
			within(dialog).queryByRole("button", { name: /Lancer une analyse/ }),
		).toBeNull();
		// Le même bouton que celui de la pilule, par `useLaunch` : un seul.
		await user.click(within(dialog).getByRole("button", { name: LAUNCH }));
		await vi.waitFor(() => expect(ai.scan).toHaveBeenCalledTimes(2));
	});

	test("erreur d'analyse sans identification, quota à 0 : le bouton du panneau est grisé et ne lance rien", async () => {
		const user = userEvent.setup();
		scanReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "analysis_failed" },
		});
		// Quota à 0 : l'analyse n'est permise que parce qu'elle est incluse
		// (identification faite par l'utilisateur).
		const noScans: ContentAccess = { ...active, remaining: { scans: 0 } };
		ai.access.mockImplementation(async () => ({ ok: true, data: noScans }));
		const accessCache = cached(noScans);
		const view = await renderIdentified({ accessCache });
		await user.click(product());
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: LAUNCH }),
		);
		await vi.waitFor(() => expect(ai.scan).toHaveBeenCalledTimes(1));
		await within(screen.getByRole("dialog")).findByText(
			aiErrorText("fr", "analysis_failed"),
		);
		// Nouvelle version de l'annonce : plus d'identification, donc plus d'inclusion.
		view.rerender(
			<RiskBadge
				report={high}
				listing={{ ...listing, title: "Vélo (prix baissé)" }}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
				aiResults={storeWith(identifiedEntry())}
			/>,
		);
		const action = within(screen.getByRole("dialog")).getByRole("button", {
			name: LAUNCH,
		});
		expect(action.getAttribute("aria-disabled")).toBe("true");
		await user.click(action);
		expect(ai.scan).toHaveBeenCalledTimes(1);
	});

	test("analyse reprise du magasin sans identification : le panneau n'a ni « Détail du produit » ni « Analyser le risque »", async () => {
		const user = userEvent.setup();
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={storeWith({
					[`${listing.site}|${listing.externalId}`]: {
						result: sampleAnalysis,
						identification: null,
						identifiedByUser: false,
						fingerprint: listingFingerprint(listing),
						storedAt: 1,
					},
				})}
			/>,
		);
		await vi.waitFor(() =>
			expect(toggle().textContent).toContain(`${sampleAnalysis.score}/100`),
		);
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).queryByText("Détail du produit")).toBeNull();
		expect(within(dialog).queryByRole("button", { name: LAUNCH })).toBeNull();
	});

	test("analyse en cours : le bouton du panneau garde le focus, et un clic est ignoré", async () => {
		const user = userEvent.setup();
		pendingScan();
		await renderIdentified({ accessCache: cached(active) });
		await user.click(product());
		const dialog = screen.getByRole("dialog");
		const action = within(dialog).getByRole("button", { name: LAUNCH });
		await user.click(action);
		const running = within(dialog).getByRole("button", {
			name: contentText("fr", "ai.loading"),
		});
		expect(running).toBe(action);
		expect(running.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(running);
		await user.click(running);
		expect(ai.scan).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(running);
	});

	test("analyse du risque en cours : le panneau montre son déroulé", async () => {
		const user = userEvent.setup();
		pendingScan();
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		emitScan({ type: "page_read", domain: "www.steamdeck.com", ok: true });
		await user.click(toggle());
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("www.steamdeck.com");
		expect(
			within(dialog)
				.getByRole("button", { name: contentText("fr", "ai.loading") })
				.getAttribute("aria-disabled"),
		).toBe("true");
	});

	test("nl : partie produit « Identificatie: … Zeker », panneau en néerlandais", async () => {
		const user = userEvent.setup();
		renderActive("nl");
		await user.click(
			screen.getByRole("button", { name: "Product identificeren" }),
		);
		const pill = await screen.findByRole("button", {
			name: "Identificatie: Steam Deck OLED · Zeker",
		});
		await user.click(pill);
		const dialog = screen.getByRole("dialog", {
			name: contentText("nl", "panel.title"),
		});
		expect(dialog.textContent).toContain("Zeker");
		expect(
			within(dialog).getByRole("button", { name: "Sluiten" }),
		).toBeTruthy();
	});

	test("panneau ouvert pendant l'identification : la ligne d'état", async () => {
		const user = userEvent.setup();
		pendingIdentify();
		renderActive();
		await user.click(identifyButton());
		emitIdentify({ type: "page_read", domain: "www.steamdeck.com", ok: true });
		await user.click(toggle());
		const dialog = aiDialog() as HTMLElement;
		expect(dialog.textContent).toContain("Lecture : www.steamdeck.com");
	});

	test("accès en erreur : « Identifier » ouvre le panneau, qui le dit une fois", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({
			ok: false,
			error: { code: "background_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog)
				.getAllByRole("alert")
				.map((alert) => alert.textContent),
		).toEqual([aiErrorText("fr", "background_unavailable")]);
		expect(ai.identify).not.toHaveBeenCalled();
	});

	test("sans abonnement, accès inconnu : « Identifier » ouvre le panneau, lien vers les formules", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({
			ok: true,
			data: { status: "noSubscription" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		const dialog = await screen.findByRole("dialog");
		const link = within(dialog).getByRole("link", {
			name: contentText("fr", "ai.pricing"),
		});
		expect(link.getAttribute("href")).toContain("/pricing/?lang=fr");
		// La pilule devient le lien vers les formules, nommé comme elle.
		expect(screen.getByRole("link", { name: IDENTIFY })).toBeTruthy();
		expect(ai.identify).not.toHaveBeenCalled();
	});

	test("useLaunch avec start = identify : déconnecté sans popup, le panneau montre le repli", async () => {
		const user = userEvent.setup();
		ai.access.mockResolvedValue({ ok: true, data: { status: "signedOut" } });
		ai.openLogin.mockResolvedValue({
			ok: false,
			error: { code: "popup_unavailable" },
		});
		render(<RiskBadge report={high} listing={listing} locale="fr" ai={ai} />);
		await user.click(identifyButton());
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain(contentText("fr", "ai.loginHint"));
		expect(dialog.textContent).toContain(contentText("fr", "ai.loginFallback"));
		expect(
			within(dialog).getAllByRole("button", {
				name: contentText("fr", "ai.login"),
			}),
		).toHaveLength(1);
	});

	test.each([
		["fr", "Inclus avec l'identification"],
		["nl", "Inbegrepen bij de identificatie"],
	] as const)(
		"%s : après l'identification, « Analyser le risque » est décrit par « %s »",
		async (locale, text) => {
			const user = userEvent.setup();
			renderActive(locale);
			await user.click(
				screen.getByRole("button", {
					name: contentText(locale, "identify.launch"),
				}),
			);
			const action = await screen.findByRole("button", {
				name: contentText(locale, "ai.analyzeRisk"),
			});
			expect(
				(action.getAttribute("aria-describedby") ?? "")
					.split(" ")
					.map((id) => document.getElementById(id)?.textContent),
			).toEqual([text]);
		},
	);

	test("action incluse à 0 analyse restante : « Analyser le risque » n'est pas grisé et l'analyse part", async () => {
		const user = userEvent.setup();
		await renderIdentified({
			accessCache: cached({ ...active, remaining: { scans: 0 } }),
		});
		expect(product()).toBeTruthy();
		expect(launch().hasAttribute("aria-disabled")).toBe(false);
		await user.click(launch());
		expect(ai.scan).toHaveBeenCalledTimes(1);
		// L'identification reprise du magasin n'est pas refaite.
		expect(ai.identify).not.toHaveBeenCalled();
	});

	test("0 analyse restante, identification venue d'une analyse : « Analyser le risque » grisé", async () => {
		const user = userEvent.setup();
		const aiResults = storeWith({
			"2ememain.be|m123": {
				result: { ...sampleAnalysis, partial: true },
				identification: sampleIdentification,
				identifiedByUser: false,
				fingerprint: listingFingerprint(listing),
				storedAt: 1,
			},
		});
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={aiResults}
				accessCache={cached({ ...active, remaining: { scans: 0 } })}
			/>,
		);
		await findLaunch();
		expect(launch().getAttribute("aria-disabled")).toBe("true");
		expect(
			(launch().getAttribute("aria-describedby") ?? "")
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent),
		).toEqual([contentText("fr", "ai.noScansLeft")]);
		await user.click(launch());
		expect(ai.scan).not.toHaveBeenCalled();
		expect(ai.access).not.toHaveBeenCalled();
	});

	test("sans abonnement : « Analyser le risque » est un lien vers les formules", async () => {
		render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				aiResults={storeWith(identifiedEntry())}
				accessCache={cached({ status: "noSubscription" })}
			/>,
		);
		const link = await screen.findByRole("link", { name: LAUNCH });
		expect(link.getAttribute("href")).toMatch(/\/pricing\/\?lang=fr$/);
		expect(queryLaunch()).toBeNull();
		expect(product()).toBeTruthy();
	});

	test("the pill never shows Identifier while the risk analysis replays the identification", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		noIdentify();
		// Le serveur refait l'identification (servie par le cache) : ses
		// événements n'animent jamais « Identifier ».
		for (const event of [
			{ type: "stage", stage: "reading_photos" },
			{ type: "criteria_cached", count: 3 },
			{ type: "page_read", domain: "www.steamdeck.com", ok: true },
			{ type: "stage", stage: "identifying" },
			identificationEvent,
			{ type: "stage", stage: "writing" },
		] as ScanProgressEvent[]) {
			emitScan(event);
			noIdentify();
			expect(toggle().getAttribute("aria-busy")).toBe("true");
			expect(toggle().textContent).toContain("Steam Deck OLED");
		}
		expect(lineOf(toggle())).toBe("Rédige le verdict");
		await finish({ ok: true, data: sampleAnalysis });
		noIdentify();
		expect(toggle().textContent).toContain(`${sampleAnalysis.score}/100`);
	});

	test("Relancer after a risk error relaunches the risk analysis and keeps the identification", async () => {
		const user = userEvent.setup();
		const first = pendingScan();
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		await first({ ok: false, error: { code: "stream_interrupted" } });
		expect(screen.queryByRole("button", { name: SURE })).toBeNull();
		const second = pendingScan();
		await user.click(
			screen.getByRole("button", { name: contentText("fr", "ai.retry") }),
		);
		expect(ai.scan).toHaveBeenCalledTimes(2);
		expect(ai.identify).not.toHaveBeenCalled();
		noIdentify();
		expect(toggle().textContent).toContain("Steam Deck OLED");
		await second({ ok: true, data: aiHigh });
		expect(toggle().textContent).toContain("82/100");
		await user.click(toggle());
		const dialog = aiDialog() as HTMLElement;
		// L'identification est toujours là, au-dessus de l'analyse.
		expect(dialog.textContent).toContain("Steam Deck OLED");
		expect(dialog.textContent).toContain("95 %");
		expect(dialog.textContent).toContain(aiHigh.summary.fr);
	});

	test("Relancer after an identification error relaunches the identification", async () => {
		const user = userEvent.setup();
		identifyReply.mockResolvedValueOnce({
			ok: false,
			error: { code: "stream_interrupted" },
		});
		renderActive();
		await user.click(identifyButton());
		await user.click(
			await screen.findByRole("button", {
				name: contentText("fr", "ai.retry"),
			}),
		);
		expect(ai.identify).toHaveBeenCalledTimes(2);
		expect(ai.scan).not.toHaveBeenCalled();
		expect(await findLaunch()).toBeTruthy();
	});

	test("navigation to another listing returns to Identifier", async () => {
		const user = userEvent.setup();
		const other: Listing = {
			...listing,
			externalId: "m456",
			url: "https://www.2ememain.be/v/velo/m456",
		};
		const accessCache = cached(active);
		const view = render(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		await identifyFirst(user);
		view.rerender(
			<RiskBadge
				report={high}
				listing={other}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		expect(identifyControls()).toHaveLength(1);
		expect(launchControls()).toHaveLength(0);
		expect(screen.queryByRole("button", { name: SURE })).toBeNull();

		// Et après un résultat du risque.
		view.rerender(
			<RiskBadge
				report={high}
				listing={listing}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		await launchToResult(user);
		view.rerender(
			<RiskBadge
				report={high}
				listing={other}
				locale="fr"
				ai={ai}
				accessCache={accessCache}
			/>,
		);
		expect(identifyControls()).toHaveLength(1);
		expect(screen.queryByRole("button", { name: /Radarnaque/ })).toBeNull();
		expect(view.container.textContent).not.toContain("/100");
	});

	test("identification_error du flux pendant l'analyse : la pilule reste sur l'analyse en cours, sans message", async () => {
		const user = userEvent.setup();
		const finish = pendingScan();
		await renderIdentified({ accessCache: cached(active) });
		await user.click(launch());
		emitScan({ type: "stage", stage: "reading_photos" });
		emitScan({ type: "identification_error", code: "analysis_failed" });
		const message = aiErrorText("fr", "analysis_failed");
		expect(screen.queryByText(message)).toBeNull();
		expect(toggle().getAttribute("aria-busy")).toBe("true");
		expect(screen.getByRole("status").textContent).not.toBe(message);
		await finish({ ok: true, data: sampleAnalysis });
		expect(toggle().textContent).toContain(`${sampleAnalysis.score}/100`);
		expect(toggle().textContent).not.toContain(message);
	});
});

describe("badge.css", () => {
	const css = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../components/badge.css"),
		"utf8",
	);
	const blockOf = (selector: string) =>
		css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

	test("les variables Tailwind issues de @property sont redéfinies sur :host et sur la racine", () => {
		const vars = [
			"--tw-border-style: solid",
			"--tw-outline-style: solid",
			"--tw-inset-shadow: 0 0 transparent",
			"--tw-inset-ring-shadow: 0 0 transparent",
			"--tw-ring-offset-shadow: 0 0 transparent",
			"--tw-ring-shadow: 0 0 transparent",
		];
		const shared = css.match(/:host,\s*\.radarnaque-root\s*\{([^}]*)\}/)?.[1];
		expect(shared).toBeDefined();
		for (const declaration of vars) expect(shared).toContain(declaration);
		expect(blockOf(":host")).not.toBe("");
	});

	test("les espacements sont en px", () => {
		expect(css).toMatch(/@theme\s*\{[^}]*--spacing:\s*4px/);
	});

	test("aucune couleur hexadécimale (resets --tw-* en transparent)", () => {
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	test("importe tailwindcss, puis les tokens, le thème et les animations du paquet design", () => {
		const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(imports).toEqual([
			"tailwindcss",
			"@radarnaque/design/tokens.css",
			"@radarnaque/design/theme.css",
			"@radarnaque/design/motion.css",
		]);
	});

	test("la police de l'hôte est celle des tokens (--font-sans)", () => {
		expect(blockOf(":host")).toMatch(/font-family:\s*var\(--font-sans\)/);
	});

	test("aucun composant n'utilise les rayons courts s, m, l (utilités logiques de Tailwind) : seulement sm, md, lg", () => {
		const dir = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../components",
		);
		const sources = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
		expect(sources.length).toBeGreaterThan(5);
		for (const name of sources) {
			const source = readFileSync(resolve(dir, name), "utf8");
			expect(source, name).not.toMatch(/(?<![\w-])rounded-[sml](?![\w-])/);
		}
	});

	test("plus d'animations propres à la pastille : rotation et fondu viennent de motion.css", () => {
		expect(css).not.toContain("@keyframes radarnaque-spin");
		expect(css).not.toContain("@keyframes radarnaque-fade");
		expect(css).not.toContain(".radarnaque-spin");
		expect(css).not.toContain(".radarnaque-fade");
	});

	test("points visibles (attente, ou « … » retiré du texte) : la troncature coupe sans « … », les points le donnent", () => {
		expect(blockOf("\\.radarnaque-status\\.has-ellipsis \\.rq-dots")).toMatch(
			/opacity:\s*1/,
		);
		const clip = css.match(
			/\.radarnaque-status\.is-waiting \.rq-shimmer,\s*\.radarnaque-status\.has-ellipsis \.rq-shimmer\s*\{([^}]*)\}/,
		)?.[1];
		expect(clip).toMatch(/text-overflow:\s*clip/);
	});

	test("animations réduites : ni rotation, ni fondu, ni points animés", () => {
		// Rotation et reflet : motion.css les coupe (testé dans le paquet design).
		// Ici, les points d'attente restent affichés, fixes.
		expect(
			blockOf("\\.radarnaque-status\\.is-waiting \\.rq-dots > span"),
		).toContain("animation:");
		// L'attente n'anime que l'opacité, jamais la largeur.
		expect(css).not.toMatch(/animation:\s*radarnaque-dots/);
		const reduced =
			css.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
		expect(reduced).toMatch(/\.rq-dots > span\s*\{[^}]*animation:\s*none;/);
	});
});
