import type { IdentificationResult, Locale } from "@radarnaque/shared";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { IdentificationSection } from "../components/IdentificationSection";
import type { IdentifyState } from "../lib/content/ai-client";
import { progressFromSearches } from "../lib/content/identification-progress";
import { contentText } from "../lib/content-i18n";
import type { ContentAccess } from "../lib/messages";
import { sampleIdentification } from "./helpers";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const active: ContentAccess = {
	status: "active",
	features: [],
	unlimited: false,
	debug: false,
	maxImages: 4,
	remaining: { scans: 3 },
};
const PRICING = "http://localhost:8080/pricing/?lang=fr";

const doneState = (result: IdentificationResult): IdentifyState => ({
	status: "done",
	result,
	progress: null,
});

function setup(
	identification: IdentifyState,
	{
		locale = "fr",
		access = active,
	}: { locale?: Locale; access?: ContentAccess } = {},
) {
	const props = {
		locale,
		identification,
		access,
		onIdentify: vi.fn(),
		onLogin: vi.fn(),
		loginUnavailable: false,
		pricingUrl: PRICING,
	};
	return { ...render(<IdentificationSection {...props} />), props };
}

/** Après `userEvent.setup()`, qui installe son propre presse-papiers. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
}

const main = sampleIdentification.objects[0] as NonNullable<
	IdentificationResult["objects"][number]
>;
const uncertain: IdentificationResult = {
	...sampleIdentification,
	status: "uncertain",
	level: "uncertain",
	confidence: 40,
	objects: [
		{
			...main,
			reference: null,
			level: "uncertain",
			confidence: 40,
			remaining: ["Modèle A", "Modèle B", "Modèle C"],
		},
	],
	sellerQuestion: { fr: "Quelle est la capacité ?", nl: "Welke capaciteit?" },
};

describe("IdentificationSection : résultat sûr", () => {
	test("référence, badge de niveau, barre à hauteur de la confiance", () => {
		const { container } = setup(doneState(sampleIdentification));
		expect(screen.getByText("Steam Deck OLED")).not.toBeNull();
		expect(screen.getByText("Sûr")).not.toBeNull();
		expect(screen.getByText("95 %")).not.toBeNull();
		const bar = container.querySelector<HTMLElement>("[style*='width']");
		expect(bar?.style.width).toBe("95%");
		expect(bar?.className).toContain("bg-text-1/60");
	});

	test("mentions de critères vérifiés et non sourcés", () => {
		setup(
			doneState({
				...sampleIdentification,
				verifiedCriteria: true,
				unsourced: true,
			}),
		);
		expect(screen.getByText("Critères vérifiés par Radarnaque")).not.toBeNull();
		expect(
			screen.getByText("Critères non confirmés par une source"),
		).not.toBeNull();
	});

	test("sans ces drapeaux : aucune mention", () => {
		setup(doneState(sampleIdentification));
		expect(screen.queryByText(/Critères vérifiés/)).toBeNull();
		expect(screen.queryByText(/non confirmés/)).toBeNull();
	});

	test("critères : vu, contraire, non visible, photo et source en lien", () => {
		const result: IdentificationResult = {
			...sampleIdentification,
			objects: [
				{
					...main,
					checks: [
						{
							observation: "seen_match",
							photo: 2,
							text: { fr: "Écran OLED", nl: "OLED-scherm" },
							sources: [
								{
									url: "https://store.example/oled",
									title: "t",
									domain: "store.example",
								},
							],
						},
						{
							observation: "seen_contrary",
							photo: null,
							text: { fr: "Capacité 256 Go", nl: "256 GB" },
							sources: [],
						},
						{
							observation: "not_visible",
							photo: null,
							text: { fr: "Numéro de série", nl: "Serienummer" },
							sources: [],
						},
					],
				},
			],
		};
		setup(doneState(result));
		const items = screen.getAllByRole("listitem");
		const first = items.find((li) => li.textContent?.includes("Écran OLED"));
		expect(first?.textContent).toContain("✓");
		expect(first?.textContent).toContain("photo 2");
		const link = within(first as HTMLElement).getByRole("link", {
			name: "store.example",
		});
		expect(link.getAttribute("href")).toBe("https://store.example/oled");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(
			items.find((li) => li.textContent?.includes("Capacité"))?.textContent,
		).toContain("✗");
		expect(
			items.find((li) => li.textContent?.includes("Numéro"))?.textContent,
		).toContain("?");
	});
});

describe("IdentificationSection : incertain", () => {
	test("candidats restants et question au vendeur", () => {
		setup(doneState(uncertain));
		expect(screen.getByText("Modèle A ou Modèle B ?")).not.toBeNull();
		expect(screen.getByText("Modèle C")).not.toBeNull();
		expect(screen.getByText("À demander au vendeur")).not.toBeNull();
		expect(screen.getByText("Quelle est la capacité ?")).not.toBeNull();
	});

	test("Copier : writeText appelé, « Copié » pendant 2 s", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		stubClipboard(writeText);
		setup(doneState(uncertain));
		await user.click(screen.getByRole("button", { name: "Copier" }));
		expect(writeText).toHaveBeenCalledWith("Quelle est la capacité ?");
		expect(await screen.findByRole("button", { name: "Copié" })).not.toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(2100);
		});
		expect(screen.getByRole("button", { name: "Copier" })).not.toBeNull();
	});

	test("presse-papiers refusé : repli silencieux", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("refusé"));
		const user = userEvent.setup();
		stubClipboard(writeText);
		setup(doneState(uncertain));
		await user.click(screen.getByRole("button", { name: "Copier" }));
		expect(writeText).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Copier" })).not.toBeNull();
	});

	test("néerlandais", () => {
		setup(doneState(uncertain), { locale: "nl" });
		expect(screen.getByText("Welke capaciteit?")).not.toBeNull();
		expect(screen.getByText("Te vragen aan de verkoper")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Kopiëren" })).not.toBeNull();
		expect(screen.getByText("Overige kandidaten")).not.toBeNull();
	});
});

describe("IdentificationSection : none, accessoires, pages", () => {
	test("none : « Produit non identifié », aucun bouton", () => {
		setup(
			doneState({
				...sampleIdentification,
				status: "none",
				confidence: 0,
				level: "uncertain",
				objects: [],
				searches: [],
			}),
		);
		expect(screen.getByText("Produit non identifié")).not.toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	const withAccessories: IdentificationResult = {
		...sampleIdentification,
		objects: [
			main,
			{
				...main,
				role: "accessory",
				label: "Chargeur",
				reference: "Chargeur 45 W",
				level: "probable",
				pages: [],
			},
			{
				...main,
				role: "accessory",
				label: "",
				reference: null,
				remaining: [],
				level: "uncertain",
				pages: [],
			},
		],
	};

	test("accessoires : libellé, référence ou « — », niveau ; libellé vide → Objet", () => {
		setup(doneState(withAccessories));
		const rows = screen.getAllByRole("listitem");
		const charger = rows.find((li) => li.textContent?.includes("Chargeur"));
		expect(charger?.textContent).toContain("Chargeur 45 W");
		expect(charger?.textContent).toContain("Probable");
		const object = rows.find((li) => li.textContent?.startsWith("Objet"));
		expect(object?.textContent).toContain("—");
		expect(object?.textContent).toContain("Incertain");
	});

	test("libellé vide en néerlandais : « Object »", () => {
		setup(doneState(withAccessories), { locale: "nl" });
		expect(
			screen
				.getAllByRole("listitem")
				.some((li) => li.textContent?.startsWith("Object")),
		).toBe(true);
	});

	test("pages de référence : https en lien, http et javascript en texte seul", () => {
		setup(
			doneState({
				...sampleIdentification,
				objects: [
					{
						...main,
						pages: [
							{
								url: "https://a.example/x",
								title: "Page A",
								domain: "a.example",
							},
							{
								url: "http://b.example/x",
								title: "Page B",
								domain: "b.example",
							},
							{
								url: "javascript:alert(1)",
								title: "Page C",
								domain: "c.example",
							},
						],
					},
				],
			}),
		);
		const link = screen.getByRole("link", { name: "Page A" });
		expect(link.getAttribute("href")).toBe("https://a.example/x");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(screen.getByText("Page B")).not.toBeNull();
		expect(screen.getByText("Page C")).not.toBeNull();
		expect(screen.queryByRole("link", { name: "Page B" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Page C" })).toBeNull();
		expect(screen.getAllByRole("link")).toHaveLength(1);
	});

	test("une source en http n'est pas un lien", () => {
		setup(
			doneState({
				...sampleIdentification,
				objects: [
					{
						...main,
						pages: [],
						checks: [
							{
								observation: "seen_match",
								photo: null,
								text: { fr: "ok", nl: "ok" },
								sources: [
									{ url: "http://x.example", title: "t", domain: "x.example" },
								],
							},
						],
					},
				],
			}),
		);
		expect(screen.getByText("x.example")).not.toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	test("un texte avec <img onerror> reste du texte", () => {
		const payload = "<img src=x onerror=alert(1)>";
		const { container } = setup(
			doneState({
				...uncertain,
				sellerQuestion: { fr: payload, nl: payload },
				objects: [
					{
						...main,
						confidence: 40,
						level: "uncertain",
						reference: null,
						label: payload,
						remaining: [payload, "B"],
						pages: [
							{ url: "https://a.example", title: payload, domain: "a.example" },
						],
					},
				],
			}),
		);
		expect(container.querySelector("img")).toBeNull();
		expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
	});
});

describe("IdentificationSection : critères non visibles", () => {
	const withChecks = (status: IdentificationResult["status"] = "uncertain") =>
		({
			...uncertain,
			status,
			objects: [
				{
					...(uncertain.objects[0] as IdentificationResult["objects"][number]),
					checks: [
						{
							text: { fr: "Capacité", nl: "Capaciteit" },
							observation: "not_visible",
							photo: null,
							sources: [],
						},
						{
							text: { fr: "Coloris", nl: "Kleur" },
							observation: "seen_match",
							photo: 1,
							sources: [],
						},
						{
							text: { fr: "Numéro de série", nl: "Serienummer" },
							observation: "not_visible",
							photo: null,
							sources: [],
						},
					],
				},
			],
		}) as IdentificationResult;

	test("incertain : « Non visible sur les photos » au-dessus de la question, FR et NL", () => {
		setup(doneState(withChecks()));
		const line = screen.getByText(
			"Non visible sur les photos : Capacité, Numéro de série",
		);
		const question = screen.getByText("Quelle est la capacité ?");
		expect(
			line.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		cleanup();
		setup(doneState(withChecks()), { locale: "nl" });
		expect(
			screen.getByText("Niet zichtbaar op de foto's: Capaciteit, Serienummer"),
		).not.toBeNull();
	});

	test("incertain sans critère non visible : rien", () => {
		setup(doneState(uncertain));
		expect(screen.queryByText(/Non visible sur les photos/)).toBeNull();
	});
});

describe("IdentificationSection : pied", () => {
	test("analyses restantes : celles du résultat, sinon de l'accès ; rien si illimité", () => {
		setup(doneState({ ...sampleIdentification, remaining: { scans: 7 } }));
		expect(screen.getByText("Analyses restantes : 7")).not.toBeNull();
		cleanup();
		setup(doneState(sampleIdentification));
		expect(screen.getByText("Analyses restantes : 3")).not.toBeNull();
		cleanup();
		setup(doneState(sampleIdentification), {
			access: { ...active, remaining: { scans: null } },
		});
		expect(screen.queryByText(/Analyses restantes/)).toBeNull();
	});

	test("le résultat porte un décompte illimité (null) : l'accès n'est pas repris", () => {
		setup(doneState({ ...sampleIdentification, remaining: { scans: null } }));
		expect(screen.queryByText(/Analyses restantes/)).toBeNull();
	});

	test("déroulé reconstruit des recherches, sans temps écoulé", async () => {
		const user = userEvent.setup();
		const { container } = setup(
			doneState({
				...sampleIdentification,
				searches: [
					{
						query: "steam deck oled",
						kind: "reference",
						pagesRead: ["store.example"],
					},
				],
			}),
		);
		const summary = screen.getByText("Déroulé de l'identification");
		await user.click(summary);
		expect(container.textContent).toContain("steam deck oled");
		expect(container.textContent).toContain("store.example");
		expect(container.textContent).not.toMatch(/\d+ s\b/);
	});

	test("déroulé en néerlandais", () => {
		setup(doneState(sampleIdentification), { locale: "nl" });
		expect(screen.getByText("Verloop van de identificatie")).not.toBeNull();
	});

	test("progressFromSearches : une recherche puis ses pages lues", () => {
		const p = progressFromSearches([
			{ query: "q", kind: "price", pagesRead: ["a.example", "b.example"] },
		]);
		expect(p.steps.map((s) => s.event.type)).toEqual([
			"search",
			"page_read",
			"page_read",
		]);
	});
});

describe("IdentificationSection : accès et erreurs", () => {
	test("idle : « Identifier le produit » lance l'identification", async () => {
		const user = userEvent.setup();
		const { props } = setup({ status: "idle" });
		await user.click(
			screen.getByRole("button", {
				name: contentText("fr", "identify.launch"),
			}),
		);
		expect(props.onIdentify).toHaveBeenCalledTimes(1);
	});

	test("erreur : message et bouton secondaire", () => {
		setup({ status: "error", code: "session_expired" });
		expect(screen.getByRole("alert")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Se connecter" })).not.toBeNull();
	});

	test("déconnecté : phrase et connexion", () => {
		setup({ status: "idle" }, { access: { status: "signedOut" } as never });
		expect(screen.getByRole("button", { name: "Se connecter" })).not.toBeNull();
	});
});
