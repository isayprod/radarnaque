// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
	contrastRatio,
	HERO_END,
	heroAnchor,
	OPEN_END,
	PALETTE_KEYS,
	paletteAt,
	RAMP_MIN,
	scrollProgress,
	skyStops,
	startSky,
} from "../src/landing/gradient";

/** `--text-2` des tokens (packages/design/src/tokens.css). */
const TEXT_2 = "rgba(226, 232, 255, 0.74)";

/** Dégradé du hero (`--grad-1` à `--grad-5`). */
const HERO = ["#0649b8", "#4e8fe8", "#c7b9ec", "#ffd4ad", "#e16c3f"];

/** Canaux 0-255 d'une couleur `#rrggbb`. */
function canaux(couleur: string): number[] {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(couleur);
	if (!m) throw new Error(`couleur inattendue : ${couleur}`);
	return [m[1], m[2], m[3]].map((c) => Number.parseInt(c ?? "", 16));
}

describe("palettes clés", () => {
	it("commencent au hero (p = 0) et finissent au pied de page (p = 1), dans l'ordre", () => {
		expect(PALETTE_KEYS[0]?.p).toBe(0);
		expect(PALETTE_KEYS[0]?.colors).toEqual(HERO);
		expect(PALETTE_KEYS.at(-1)?.p).toBe(1);
		const ps = PALETTE_KEYS.map((k) => k.p);
		expect([...ps].sort((a, b) => a - b)).toEqual(ps);
		expect(new Set(ps).size).toBe(ps.length);
		// La fin du hero (spec §5.1) est une clé.
		expect(ps).toContain(HERO_END);
	});
});

describe("paletteAt", () => {
	it("p = 0 : le dégradé du hero ; p = 1 : la dernière palette ; p hors de [0, 1] borné", () => {
		expect(paletteAt(0)).toEqual(HERO);
		expect(paletteAt(1)).toEqual(PALETTE_KEYS.at(-1)?.colors);
		expect(paletteAt(-1)).toEqual(paletteAt(0));
		expect(paletteAt(2)).toEqual(paletteAt(1));
		expect(paletteAt(Number.NaN)).toEqual(paletteAt(0));
	});

	it("rend chaque palette clé à sa valeur de p", () => {
		for (const key of PALETTE_KEYS)
			expect(paletteAt(key.p), String(key.p)).toEqual(key.colors);
	});

	it("est continue : d'un pas de 0,001 au suivant, aucun canal ne bouge de 3 ou plus (sur 255)", () => {
		let avant = paletteAt(0).map(canaux);
		for (let i = 1; i <= 1000; i++) {
			const p = i / 1000;
			const apres = paletteAt(p).map(canaux);
			apres.forEach((couleur, arret) => {
				couleur.forEach((canal, c) => {
					const ecart = Math.abs(canal - (avant[arret]?.[c] ?? 0));
					expect(ecart, `p = ${p}, arrêt ${arret + 1}`).toBeLessThan(3);
				});
			});
			avant = apres;
		}
	});

	it("change visiblement entre la fin du hero et le pied de page (pas un aplat de navy)", () => {
		// Écart simple : somme des écarts de canaux de l'arrêt du bas.
		const bas = (p: number) => canaux(paletteAt(p)[4]);
		const ecart = (a: number[], b: number[]) =>
			a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0);
		expect(ecart(bas(HERO_END), bas(0.6))).toBeGreaterThan(40);
		expect(ecart(bas(0.6), bas(1))).toBeGreaterThan(40);
	});

	it("contraste : pour p de 0,15 à 1 (pas de 0,01), --text-2 garde 4,5:1 sur chaque arrêt", () => {
		let minimum = Number.POSITIVE_INFINITY;
		for (let i = 15; i <= 100; i++) {
			const p = i / 100;
			paletteAt(p).forEach((arret, n) => {
				const ratio = contrastRatio(TEXT_2, arret);
				minimum = Math.min(minimum, ratio);
				expect(
					ratio,
					`p = ${p}, arrêt ${n + 1} (${arret})`,
				).toBeGreaterThanOrEqual(4.5);
			});
		}
		expect(minimum).toBeGreaterThanOrEqual(4.5);
	});
});

describe("contrastRatio", () => {
	it("blanc sur noir : 21:1 ; même couleur : 1:1 ; symétrique sans alpha", () => {
		expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrastRatio("#0649b8", "#0649b8")).toBeCloseTo(1, 5);
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
	});

	it("compose l'alpha du premier plan sur le fond", () => {
		// Un premier plan transparent n'est que le fond : 1:1.
		expect(contrastRatio("rgba(255, 255, 255, 0)", "#020b2d")).toBeCloseTo(
			1,
			5,
		);
		// 74 % de blanc sur navy : moins que le blanc plein.
		const plein = contrastRatio("#ffffff", "#020b2d");
		const voile = contrastRatio("rgba(255, 255, 255, 0.74)", "#020b2d");
		expect(voile).toBeLessThan(plein);
		expect(voile).toBeGreaterThan(4.5);
		// Valeur de référence : --text-2 sur --bg-0, environ 8,8:1.
		expect(contrastRatio(TEXT_2, "#020b2d")).toBeCloseTo(8.81, 2);
	});

	it("refuse une couleur illisible", () => {
		expect(() => contrastRatio("bleu", "#000000")).toThrow();
	});
});

describe("scrollProgress", () => {
	it("0 en haut, HERO_END au repère de fin du hero, 1 en bas, borné", () => {
		expect(scrollProgress(0, 3000, 600)).toBe(0);
		expect(scrollProgress(600, 3000, 600)).toBeCloseTo(HERO_END, 10);
		expect(scrollProgress(3000, 3000, 600)).toBe(1);
		expect(scrollProgress(-50, 3000, 600)).toBe(0);
		expect(scrollProgress(5000, 3000, 600)).toBe(1);
	});

	it("croît avec le scroll", () => {
		let avant = -1;
		for (let y = 0; y <= 3000; y += 10) {
			const p = scrollProgress(y, 3000, 600);
			expect(p).toBeGreaterThanOrEqual(avant);
			avant = p;
		}
	});

	it("page sans scroll : 0", () => {
		expect(scrollProgress(0, 0, 0)).toBe(0);
	});
});

describe("heroAnchor", () => {
	it("fenêtre basse : le premier texte entre en bas de la fenêtre (1441 − 900 px)", () => {
		expect(
			heroAnchor({
				heroHeight: 867,
				firstTextTop: 1441,
				viewport: 900,
				max: 2351,
			}),
		).toBe(541);
	});

	it("fenêtre haute (texte visible en haut de page) : rampe de RAMP_MIN px au moins, pas de saut au premier pixel", () => {
		expect(RAMP_MIN).toBeGreaterThanOrEqual(200);
		// 1080 × 1800 : le premier texte est à 1430 px, dans la fenêtre dès y = 0.
		expect(
			heroAnchor({
				heroHeight: 815,
				firstTextTop: 1430,
				viewport: 1800,
				max: 1500,
			}),
		).toBe(RAMP_MIN);
		// Premier texte juste sous la fenêtre : rampe minimale aussi.
		expect(
			heroAnchor({
				heroHeight: 900,
				firstTextTop: 1900,
				viewport: 1800,
				max: 1900,
			}),
		).toBe(RAMP_MIN);
	});

	it("au plus le hero entier et la moitié du scroll, 1 px au moins", () => {
		expect(
			heroAnchor({
				heroHeight: 700,
				firstTextTop: 2400,
				viewport: 600,
				max: 5000,
			}),
		).toBe(700);
		expect(
			heroAnchor({
				heroHeight: 900,
				firstTextTop: 1700,
				viewport: 900,
				max: 600,
			}),
		).toBe(300);
		expect(
			heroAnchor({
				heroHeight: 900,
				firstTextTop: 1700,
				viewport: 900,
				max: 0,
			}),
		).toBe(1);
	});

	it("fenêtre basse : p atteint 0,15 dès que le premier texte entre dans la fenêtre", () => {
		const m = {
			heroHeight: 900,
			firstTextTop: 1950,
			viewport: 1500,
			max: 3000,
		};
		const anchor = heroAnchor(m);
		const yEntree = m.firstTextTop - m.viewport;
		expect(scrollProgress(yEntree, m.max, anchor)).toBeGreaterThanOrEqual(
			HERO_END,
		);
	});
});

/** Canaux 0-255 d'une couleur `#rrggbb`. */
const rgb = (c: string) => canaux(c);

/** Couleur peinte par le calque à `y` (pixels dans la fenêtre), interpolée en sRGB comme le navigateur. */
function couleurA(stops: number[], couleurs: string[], y: number): string {
	const k = couleurs.map(rgb);
	const premier = stops[0] ?? 0;
	if (y <= premier) return couleurs[0] ?? "";
	for (let i = 1; i < stops.length; i++) {
		const a = stops[i - 1] ?? 0;
		const b = stops[i] ?? 0;
		if (y <= b) {
			const t = b === a ? 1 : (y - a) / (b - a);
			const c = (k[i - 1] ?? []).map((v, n) => v + ((k[i]?.[n] ?? v) - v) * t);
			return `rgb(${c.join(", ")})`;
		}
	}
	return couleurs.at(-1) ?? "";
}

/** --bg-0 des tokens. */
const BG_0 = "#020b2d";

/** Fenêtres mesurées dans le navigateur (hero, queue, premier texte, scroll). */
const FENETRES = [
	{ nom: "1080 × 1800", H: 815, tail: 343, V: 1800, text: 1430, max: 1500 },
	{ nom: "2560 × 1500", H: 891, tail: 384, V: 1500, text: 1465, max: 1775 },
	{ nom: "1024 × 1366", H: 700, tail: 330, V: 1366, text: 1250, max: 1750 },
	{ nom: "1440 × 900", H: 867, tail: 384, V: 900, text: 1449, max: 2351 },
	{ nom: "390 × 844", H: 578, tail: 204, V: 844, text: 1012, max: 3045 },
];

describe("skyStops", () => {
	const m = { heroHeight: 867, tail: 384, fade: 120, viewport: 900 };

	it("p = 0, texte loin : positions du hero (mêmes formules que .landing-hero), --sky-below --sky-fade plus bas", () => {
		expect(skyStops(m, 0, 1449)).toEqual([
			0,
			867 - 384,
			867 - 384 * 0.62,
			867 - 384 * 0.36,
			867 - 384 * 0.16,
			867,
			867 + 120,
		]);
	});

	it("après OPEN_END : espacement régulier sur la fenêtre, --sky-below au bas (invisible)", () => {
		expect(OPEN_END).toBeGreaterThan(HERO_END);
		expect(skyStops(m, OPEN_END, 100)).toEqual([0, 0, 225, 450, 675, 900, 900]);
	});

	it("tant que p < HERO_END, --sky-below commence au-dessus du premier texte visible", () => {
		for (const p of [0.02, 0.07, 0.12, 0.149]) {
			const stops = skyStops(m, p, 500);
			expect(stops.at(-1), String(p)).toBeLessThanOrEqual(500);
		}
	});

	it("positions croissantes, jamais négatives", () => {
		for (let p = 0; p <= 1; p += 0.01)
			for (const textTop of [-400, 0, 300, 2000]) {
				const stops = skyStops(m, p, textTop);
				stops.forEach((y, i) => {
					expect(y).toBeGreaterThanOrEqual(i === 0 ? 0 : (stops[i - 1] ?? 0));
				});
			}
	});

	it.each(FENETRES)(
		"$nom : rampe d'au moins 200 px, et à toute position du scroll, le texte sous le premier bloc est sur une couleur à 4,5:1",
		({ H, tail, V, text, max }) => {
			const metrics = { heroHeight: H, tail, fade: 120, viewport: V };
			const anchor = heroAnchor({
				heroHeight: H,
				firstTextTop: text,
				viewport: V,
				max,
			});
			expect(anchor).toBeGreaterThanOrEqual(200);
			let minimum = Number.POSITIVE_INFINITY;
			for (let y = 0; y <= max; y += 4) {
				const p = scrollProgress(y, max, anchor);
				const textTop = text - y;
				if (textTop >= V) continue;
				const stops = skyStops(metrics, p, textTop);
				const [s1, s2, s3, s4, s5] = paletteAt(p);
				const couleurs = [s1, s1, s2, s3, s4, s5, BG_0];
				for (let ty = Math.max(0, textTop); ty <= V; ty += 6) {
					const ratio = contrastRatio(TEXT_2, couleurA(stops, couleurs, ty));
					minimum = Math.min(minimum, ratio);
					if (ratio < 4.5)
						throw new Error(
							`y = ${y}, texte à ${ty} px : ${ratio.toFixed(2)}:1`,
						);
				}
			}
			expect(minimum).toBeGreaterThanOrEqual(4.5);
		},
	);
});

/** Fenêtre factice : écouteurs, images (`requestAnimationFrame`) et hauteurs contrôlés. */
function fenetre() {
	const ecouteurs = new Map<string, EventListener>();
	const images: FrameRequestCallback[] = [];
	const win = {
		scrollY: 0,
		innerHeight: 900,
		document: {
			documentElement: { scrollHeight: 4900 },
			querySelector: () => null,
		},
		addEventListener: vi.fn((type: string, fn: EventListener) => {
			ecouteurs.set(type, fn);
		}),
		removeEventListener: vi.fn((type: string, fn: EventListener) => {
			if (ecouteurs.get(type) === fn) ecouteurs.delete(type);
		}),
		requestAnimationFrame: vi.fn((fn: FrameRequestCallback) => {
			images.push(fn);
			return images.length;
		}),
		cancelAnimationFrame: vi.fn(),
	};
	const image = () => {
		const enAttente = images.splice(0);
		for (const fn of enAttente) fn(0);
	};
	const emettre = (type: string) => ecouteurs.get(type)?.(new Event(type));
	return { win, ecouteurs, image, emettre };
}

describe("startSky", () => {
	it("écrit les cinq couleurs de la position de départ à la première image", () => {
		const { win, image } = fenetre();
		const calque = document.createElement("div");
		startSky(win as unknown as Window, calque);
		image();
		const attendu = paletteAt(0);
		for (let i = 0; i < 5; i++)
			expect(calque.style.getPropertyValue(`--s${i + 1}`)).toBe(attendu[i]);
	});

	it("écouteur scroll passif ; une seule écriture des cinq variables par image, même après dix événements", () => {
		const { win, image, emettre } = fenetre();
		const calque = document.createElement("div");
		startSky(win as unknown as Window, calque);
		expect(win.addEventListener).toHaveBeenCalledWith(
			"scroll",
			expect.any(Function),
			expect.objectContaining({ passive: true }),
		);
		image();
		const ecriture = vi.spyOn(calque.style, "setProperty");
		win.requestAnimationFrame.mockClear();
		for (let i = 1; i <= 10; i++) {
			win.scrollY = i * 100;
			emettre("scroll");
		}
		expect(win.requestAnimationFrame).toHaveBeenCalledTimes(1);
		expect(ecriture).not.toHaveBeenCalled();
		image();
		for (let i = 1; i <= 5; i++) {
			expect(
				ecriture.mock.calls.filter(([nom]) => nom === `--s${i}`),
			).toHaveLength(1);
		}
		// Écrit la palette de la dernière position (1000 px sur 4000 sans repère : p = 0,25).
		expect(calque.style.getPropertyValue("--s5")).toBe(
			paletteAt(scrollProgress(1000, 4000, HERO_END * 4000))[4],
		);
	});

	it("relit la hauteur de la page au redimensionnement, pas à chaque image", () => {
		const { win, image, emettre } = fenetre();
		const calque = document.createElement("div");
		startSky(win as unknown as Window, calque);
		image();
		win.document.documentElement.scrollHeight = 1900; // max = 1000
		win.scrollY = 1000;
		emettre("scroll");
		image();
		// Hauteur pas encore relue : 1000 sur 4000.
		expect(calque.style.getPropertyValue("--s5")).not.toBe(paletteAt(1)[4]);
		emettre("resize");
		image();
		expect(calque.style.getPropertyValue("--s5")).toBe(paletteAt(1)[4]);
	});

	it("s'arrête proprement : écouteurs retirés, image en attente annulée", () => {
		const { win, ecouteurs, emettre } = fenetre();
		const calque = document.createElement("div");
		const arreter = startSky(win as unknown as Window, calque);
		emettre("scroll");
		arreter();
		expect(ecouteurs.size).toBe(0);
		expect(win.cancelAnimationFrame).toHaveBeenCalled();
		win.requestAnimationFrame.mockClear();
		emettre("scroll");
		expect(win.requestAnimationFrame).not.toHaveBeenCalled();
	});
});
