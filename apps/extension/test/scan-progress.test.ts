import type { ScanProgressEvent } from "@radarnaque/shared";
import { describe, expect, test } from "vitest";
import {
	addEvent,
	MAX_PROGRESS_STEPS,
	type ScanProgress,
	STATUS_LINE_MAX,
	startProgress,
	statusLine,
	thinkingTitle,
} from "../lib/content/scan-progress";
import { sampleIdentification } from "./helpers";

/** Progression partie de 1 000 ms, puis un événement par seconde. */
function progressOf(...events: ScanProgressEvent[]): ScanProgress {
	return events.reduce(
		(p, e, i) => addEvent(p, e, 2_000 + i * 1_000),
		startProgress(1_000),
	);
}

const lineOf = (locale: "fr" | "nl", ...events: ScanProgressEvent[]) =>
	statusLine(progressOf(...events), locale);

describe("startProgress et addEvent", () => {
	test("départ : aucune étape, aucun événement", () => {
		expect(startProgress(1_000)).toEqual({
			startedAt: 1_000,
			steps: [],
			last: null,
			lastAt: 1_000,
		});
	});

	test("chaque événement ajoute une étape datée ; last et lastAt suivent", () => {
		const photos = { type: "stage", stage: "photos", count: 3 } as const;
		const search = {
			type: "search",
			id: 1,
			query: "vélo prix",
			aspect: "price",
		} as const;
		const start = startProgress(1_000);
		const p = addEvent(addEvent(start, photos, 2_000), search, 3_500);
		expect(p).toEqual({
			startedAt: 1_000,
			steps: [
				{ at: 2_000, event: photos },
				{ at: 3_500, event: search },
			],
			last: search,
			lastAt: 3_500,
		});
		// La progression d'origine n'est pas modifiée (état React).
		expect(start.steps).toEqual([]);
	});

	test("un thinking de la même partie remplace l'étape au lieu de s'ajouter", () => {
		const first = { type: "thinking", part: 0, text: "**Prix**" } as const;
		const longer = {
			type: "thinking",
			part: 0,
			text: "**Prix**\n\nJe compare.",
		} as const;
		const other = { type: "thinking", part: 1, text: "**Photos**" } as const;
		let p = addEvent(startProgress(0), first, 1_000);
		p = addEvent(p, longer, 2_000);
		expect(p.steps).toEqual([{ at: 1_000, event: longer }]);
		expect(p.last).toBe(longer);
		expect(p.lastAt).toBe(2_000);
		p = addEvent(p, other, 3_000);
		expect(p.steps.map((s) => s.event)).toEqual([longer, other]);
	});

	test(`150 événements gardent ${MAX_PROGRESS_STEPS} étapes, les plus récentes`, () => {
		let p = startProgress(0);
		for (let id = 0; id < 150; id++)
			p = addEvent(
				p,
				{ type: "search", id, query: `q${id}`, aspect: "other" },
				id,
			);
		expect(MAX_PROGRESS_STEPS).toBe(100);
		expect(p.steps).toHaveLength(100);
		expect(p.steps[0]?.event).toMatchObject({ id: 50 });
		expect(p.last).toMatchObject({ id: 149 });
	});
});

describe("thinkingTitle", () => {
	test("le premier segment **…**", () => {
		expect(thinkingTitle("**Vérifie le prix**\n\nJe compare…")).toBe(
			"Vérifie le prix",
		);
		expect(thinkingTitle("Intro **Un** puis **Deux**")).toBe("Un");
	});

	test("titre en cours d'arrivée (** sans fermant) : le texte après le marqueur", () => {
		expect(thinkingTitle("**Vérifie le pr")).toBe("Vérifie le pr");
		expect(thinkingTitle("**  ** puis **Compare")).toBe("Compare");
		// Marqueur ouvrant seul : pas encore de titre, la phrase d'avant.
		expect(thinkingTitle("Je regarde. **")).toBe("Je regarde.");
	});

	test("sans titre : la dernière phrase non vide", () => {
		expect(thinkingTitle("Je regarde le prix. Il est bas.\n\n")).toBe(
			"Il est bas.",
		);
		expect(thinkingTitle("Première ligne\nJe compare avec")).toBe(
			"Je compare avec",
		);
		// Segment **…** vide : pas un titre ; marqueurs retirés, espaces resserrés.
		expect(thinkingTitle("**  **Seule   phrase.")).toBe("Seule phrase.");
		expect(thinkingTitle("****")).toBe("");
	});

	test("texte vide : chaîne vide", () => {
		expect(thinkingTitle("  \n ")).toBe("");
	});
});

describe("statusLine", () => {
	const rows: Array<[string, ScanProgressEvent[], string, string]> = [
		["aucun événement", [], "Démarrage de l'analyse", "Analyse wordt gestart"],
		[
			"photos",
			[{ type: "stage", stage: "photos", count: 3 }],
			"Téléchargement de 3 photos",
			"3 foto's downloaden",
		],
		[
			"photos, une seule",
			[{ type: "stage", stage: "photos", count: 1 }],
			"Téléchargement d'1 photo",
			"1 foto downloaden",
		],
		[
			"analyzing avec photos",
			[{ type: "stage", stage: "analyzing", count: 3 }],
			"Examine l'annonce et 3 photos",
			"Bekijkt de advertentie en 3 foto's",
		],
		[
			"analyzing, une photo",
			[{ type: "stage", stage: "analyzing", count: 1 }],
			"Examine l'annonce et 1 photo",
			"Bekijkt de advertentie en 1 foto",
		],
		[
			"analyzing sans photo",
			[{ type: "stage", stage: "analyzing", count: 0 }],
			"Examine l'annonce sans photo",
			"Bekijkt de advertentie zonder foto",
		],
		[
			"analyzing sans count",
			[{ type: "stage", stage: "analyzing" }],
			"Examine l'annonce sans photo",
			"Bekijkt de advertentie zonder foto",
		],
		[
			"cache",
			[{ type: "stage", stage: "cache" }],
			"Analyse déjà disponible",
			"Analyse al beschikbaar",
		],
		[
			"thinking",
			[{ type: "thinking", part: 0, text: "**Vérifie le prix**\n\nJe…" }],
			"Vérifie le prix",
			"Vérifie le prix",
		],
		[
			"search, modèle",
			[{ type: "search", id: 1, query: "iPhone 18 Pro", aspect: "model" }],
			"Recherche web (modèle) : “iPhone 18 Pro”",
			"Webzoekopdracht (model): “iPhone 18 Pro”",
		],
		[
			"search, prix du marché",
			[{ type: "search", id: 1, query: "iPhone prix", aspect: "price" }],
			"Recherche web (prix du marché) : “iPhone prix”",
			"Webzoekopdracht (marktprijs): “iPhone prix”",
		],
		[
			"search, arnaque connue",
			[{ type: "search", id: 1, query: "arnaque", aspect: "scam" }],
			"Recherche web (arnaque connue) : “arnaque”",
			"Webzoekopdracht (bekende oplichting): “arnaque”",
		],
		[
			"search, autre",
			[{ type: "search", id: 1, query: "vélo", aspect: "other" }],
			"Recherche web (autre) : “vélo”",
			"Webzoekopdracht (overig): “vélo”",
		],
		[
			"search_done ok",
			[
				{
					type: "search_done",
					id: 1,
					ok: true,
					count: 5,
					domains: ["apple.com", "tweakers.net"],
				},
			],
			"5 résultats : apple.com, tweakers.net",
			"5 resultaten: apple.com, tweakers.net",
		],
		[
			"search_done ok, un résultat",
			[
				{
					type: "search_done",
					id: 1,
					ok: true,
					count: 1,
					domains: ["apple.com"],
				},
			],
			"1 résultat : apple.com",
			"1 resultaat: apple.com",
		],
		[
			"search_done ok, sans domaine",
			[{ type: "search_done", id: 1, ok: true, count: 0, domains: [] }],
			"0 résultat",
			"0 resultaten",
		],
		[
			"search_done en échec",
			[{ type: "search_done", id: 1, ok: false, count: 0, domains: [] }],
			"Recherche indisponible, l'analyse continue",
			"Zoekopdracht niet beschikbaar, de analyse gaat door",
		],
		[
			"writing",
			[{ type: "stage", stage: "writing" }],
			"Rédige le verdict",
			"Schrijft het oordeel",
		],
	];

	test.each(rows)("%s : FR et NL", (_name, events, fr, nl) => {
		expect(lineOf("fr", ...events)).toBe(fr);
		expect(lineOf("nl", ...events)).toBe(nl);
	});

	test("espaces de la requête resserrés, sauts de ligne compris", () => {
		expect(
			lineOf("fr", {
				type: "search",
				id: 1,
				query: "  vélo\n\n  cargo \t prix ",
				aspect: "price",
			}),
		).toBe("Recherche web (prix du marché) : “vélo cargo prix”");
	});

	test("une requête qui contient {count} ou {domains} reste telle quelle", () => {
		expect(
			lineOf("fr", {
				type: "search",
				id: 1,
				query: "{count} {domains} {query}",
				aspect: "other",
			}),
		).toBe("Recherche web (autre) : “{count} {domains} {query}”");
		expect(
			lineOf("nl", {
				type: "search_done",
				id: 1,
				ok: true,
				count: 2,
				domains: ["{results}.be", "{count}.nl"],
			}),
		).toBe("2 resultaten: {results}.be, {count}.nl");
	});

	test("un thinking vidé par le nettoyage ne remplace pas la ligne précédente", () => {
		expect(
			lineOf(
				"fr",
				{ type: "stage", stage: "writing" },
				{ type: "thinking", part: 1, text: "** **" },
			),
		).toBe("Rédige le verdict");
	});

	test("suit le dernier événement", () => {
		expect(
			lineOf(
				"fr",
				{ type: "stage", stage: "photos", count: 2 },
				{ type: "stage", stage: "writing" },
			),
		).toBe("Rédige le verdict");
	});

	test(`coupée à ${STATUS_LINE_MAX} caractères avec « … »`, () => {
		const query = "x".repeat(200);
		const line = lineOf("fr", {
			type: "search",
			id: 1,
			query,
			aspect: "price",
		});
		expect(STATUS_LINE_MAX).toBe(60);
		expect(Array.from(line)).toHaveLength(60);
		expect(line.endsWith("…")).toBe(true);
		expect(line.startsWith("Recherche web (prix du marché) : “xxx")).toBe(true);
	});

	test("exactement 60 caractères : pas de coupe", () => {
		const text = "a".repeat(60);
		expect(lineOf("fr", { type: "thinking", part: 0, text })).toBe(text);
	});

	test("un emoji n'est jamais coupé en deux", () => {
		const text = `${"a".repeat(58)}😀😀😀`;
		const line = lineOf("fr", { type: "thinking", part: 0, text });
		expect(line).toBe(`${"a".repeat(58)}😀…`);
	});

	test("thinking vide : la ligne de l'étape précédente", () => {
		expect(
			lineOf(
				"fr",
				{ type: "stage", stage: "writing" },
				{ type: "thinking", part: 1, text: "  " },
			),
		).toBe("Rédige le verdict");
		expect(lineOf("nl", { type: "thinking", part: 1, text: "" })).toBe(
			"Analyse wordt gestart",
		);
	});
});

describe("étapes et événements de l'identification", () => {
	const cases: Array<[ScanProgressEvent, string, string]> = [
		[
			{ type: "stage", stage: "reading_photos" },
			"Lecture des photos…",
			"Foto's lezen…",
		],
		[
			{ type: "stage", stage: "criteria" },
			"Recherche des critères…",
			"Criteria zoeken…",
		],
		[
			{ type: "criteria_cached", count: 3 },
			"Critères connus de Radarnaque",
			"Criteria al bekend bij Radarnaque",
		],
		[
			{ type: "page_read", domain: "versus.example", ok: true },
			"Lecture : versus.example",
			"Lezen: versus.example",
		],
		[
			{ type: "stage", stage: "identifying" },
			"Vérification des critères…",
			"Criteria controleren…",
		],
		[
			{ type: "stage", stage: "retrying" },
			"Vérification complémentaire…",
			"Extra controle…",
		],
		[
			{ type: "identification_error", code: "identify_resolve" },
			"Identification impossible",
			"Identificatie mislukt",
		],
	];

	test.each(cases)("%j : une ligne en FR et en NL", (event, fr, nl) => {
		expect(lineOf("fr", event)).toBe(fr);
		expect(lineOf("nl", event)).toBe(nl);
	});

	test("identification : Produit identifié", () => {
		const event = {
			...sampleIdentification,
			type: "identification",
		} as ScanProgressEvent;
		expect(lineOf("fr", event)).toBe("Produit identifié");
		expect(lineOf("nl", event)).toBe("Product geïdentificeerd");
	});

	test("page_read en échec ne change pas la ligne", () => {
		const reading = { type: "stage", stage: "reading_photos" } as const;
		const failed = {
			type: "page_read",
			domain: "x.example",
			ok: false,
		} as const;
		expect(lineOf("fr", reading, failed)).toBe("Lecture des photos…");
	});
});
