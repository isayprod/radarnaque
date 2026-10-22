/**
 * Script de la landing (spec landing §2 et §5), module sans dépendance : pose
 * `html.js` (les apparitions et le calque ne s'appliquent qu'avec JavaScript),
 * pilote le dégradé au scroll et les apparitions, puis remplit les formules depuis
 * `GET /api/offer`. Si la route est lente, en panne ou répond mal, le HTML rendu
 * au build garde ses valeurs de secours.
 */
import type { Locale } from "@radarnaque/shared";
import { toDom } from "../h.ts";
import { fetchOffer, type Offer, parseOffer } from "../offer.ts";
import { startSky } from "./gradient.ts";
import { planPanelNode } from "./render.ts";

const PLAN_KEYS = ["trial", "standard", "premium"] as const;

/**
 * Apparitions (spec §5.2) : chaque bloc `data-reveal` reçoit `is-visible` une
 * seule fois, quand 15 % de sa surface entre dans la fenêtre. Sans
 * `IntersectionObserver`, tout est rendu visible tout de suite. Renvoie l'arrêt.
 */
export function startReveal(doc: Document): () => void {
	const blocks = [...doc.querySelectorAll<HTMLElement>("[data-reveal]")];
	const Observer = globalThis.IntersectionObserver;
	if (typeof Observer !== "function") {
		for (const block of blocks) block.classList.add("is-visible");
		return () => {};
	}
	const observer = new Observer(
		(entries, obs) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add("is-visible");
				obs.unobserve(entry.target);
			}
		},
		{ threshold: 0.15 },
	);
	for (const block of blocks) observer.observe(block);
	return () => observer.disconnect();
}

/**
 * Écrit l'offre en cours dans les panneaux des formules (mêmes règles que le
 * rendu au build : `planPanelNode`). Le panneau reste le même élément (classe
 * `is-visible`, rang `--i`), seul son contenu change. Offre invalide ou absente :
 * rien ne bouge (valeurs de secours du HTML).
 */
export function fillOffer(
	doc: Document,
	locale: Locale,
	offer: Offer | null,
): void {
	const valid = parseOffer(offer);
	if (!valid) return;
	for (const key of PLAN_KEYS) {
		const panel = doc.querySelector<HTMLElement>(`[data-plan="${key}"]`);
		if (!panel) continue;
		const fresh = toDom(doc, planPanelNode(locale, key, valid[key]));
		if (fresh.textContent === panel.textContent) continue;
		panel.replaceChildren(...fresh.childNodes);
	}
}

/**
 * Démarre la landing : `html.js` en premier (déjà posée en ligne dans `<head>`,
 * sans effet si elle y est). Script arrivé après l'abandon du script en ligne
 * (`data-js-late`, au bout de 3 s) : le lecteur voit déjà tous les blocs, ils
 * reçoivent `is-visible` avant que `js` revienne, aucun n'est recaché. Puis le
 * calque du dégradé et les apparitions, chacun protégé. Les deux lancés :
 * `html.js-ready` (la page devient transparente sur le calque, et le script en
 * ligne ne retire plus `js`). L'un des deux en échec :
 * `js` est retirée tout de suite, la page reste celle sans JavaScript, lisible.
 * Enfin la lecture de l'offre (résolue quand les formules sont à jour).
 */
export async function startLanding(
	win: Window,
	fetchImpl?: typeof fetch,
): Promise<void> {
	const doc = win.document;
	const root = doc.documentElement;
	if (root.hasAttribute("data-js-late"))
		for (const block of doc.querySelectorAll("[data-reveal]"))
			block.classList.add("is-visible");
	root.classList.add("js");
	const armed = [
		() => {
			const sky = doc.querySelector<HTMLElement>(".sky");
			if (sky) startSky(win, sky);
		},
		() => startReveal(doc),
	].map((start) => {
		try {
			start();
			return true;
		} catch (error) {
			console.error(error);
			return false;
		}
	});
	if (armed.every(Boolean)) root.classList.add("js-ready");
	else root.classList.remove("js");
	const locale: Locale = root.lang === "nl" ? "nl" : "fr";
	try {
		fillOffer(doc, locale, await fetchOffer(fetchImpl));
	} catch (error) {
		console.error(error);
	}
}

// Démarrage seulement sur la landing (calque présent), pas à l'import des tests.
if (typeof document !== "undefined" && document.querySelector(".sky"))
	void startLanding(window);
