import type { Locale } from "@radarnaque/shared";
import { canUse } from "../access";
import { adapterFor } from "../adapters/registry";
import type { CardRef, MarketplaceAdapter } from "../adapters/types";
import type { Site } from "../listing/types";
import type { ContentAccess } from "../messages";
import type { AiClient, ScanState } from "./ai-client";
import { defaultFetchPage, scanCard } from "./card-scan";
import { BADGE_HOST_TAG, CARD_HOST_TAG } from "./controller";

export { CARD_HOST_TAG };

/** Attribut posé sur la carte : son icône y est déjà montée. */
const MARK_ATTR = "data-radarnaque-card";

/** Les mutations du DOM déclenchent au plus un `refresh` toutes les 250 ms. */
const THROTTLE_MS = 250;

/** Erreurs de session : l'accès est relu (il peut être devenu `signedOut`). */
const RELOGIN_CODES = new Set(["session_expired", "unauthenticated"]);

/** Hôte retiré par le site, même carte et même ancre : remontages par annonce et par URL. */
const MAX_REMOUNTS = 3;

/** Accès `noSubscription` ou en erreur : relu au plus une fois toutes les 30 s (R5). */
const RECHECK_MS = 30_000;

const IDLE: ScanState = { status: "idle" };

/** Ce que l'icône d'une carte affiche, et son action au clic. */
export interface CardView {
	state: ScanState;
	locale: Locale;
	onActivate(): void;
}

/** Icône montée pour une carte. */
export interface CardMount {
	update(view: CardView): void;
	unmount(): void;
	/** Vrai tant que l'hôte est dans le document (ou en cours de montage). */
	isMounted(): boolean;
}

export interface CardControllerDeps {
	doc: Document;
	getUrl(): URL;
	ai: AiClient;
	/** Monte l'icône APRÈS `anchor`. */
	mountCard(anchor: Element, card: CardRef, view: CardView): CardMount;
	getLocale(site: Site): Promise<Locale>;
	/** Fenêtre dont le `focus` relit un accès inactif ; `doc.defaultView` par défaut. */
	win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
	scan?: typeof scanCard;
	fetchPage?: (url: string) => Promise<string>;
	log?: (msg: string) => void;
}

interface Tracked {
	card: CardRef;
	/** Élément après lequel l'icône a été montée. */
	anchor: Element;
	mount: CardMount;
}

const isOwnUi = (node: Node) =>
	node.nodeType === Node.ELEMENT_NODE &&
	((node as Element).localName === CARD_HOST_TAG ||
		(node as Element).localName === BADGE_HOST_TAG);

/** Mutation due uniquement à l'insertion de nos hôtes ; un retrait reste observé. */
function isOwnInsertion(record: MutationRecord): boolean {
	return (
		record.type === "childList" &&
		record.removedNodes.length === 0 &&
		record.addedNodes.length > 0 &&
		[...record.addedNodes].every(isOwnUi)
	);
}

/**
 * Point de montage de l'icône (R2) : l'ancre de l'adaptateur, sauf si elle ou
 * un de ses ancêtres dans la carte est `aria-hidden` ; l'icône suit alors le
 * plus haut de ces ancêtres, pour rester accessible.
 */
function mountPointOf(
	adapter: MarketplaceAdapter,
	card: Element,
): Element | null {
	let anchor = adapter.cardAnchor(card);
	// Notre hôte, inséré après l'ancre, peut devenir le dernier enfant que
	// l'adaptateur descend (Facebook) : l'ancre reste l'élément qui le précède.
	while (anchor && isOwnUi(anchor)) anchor = anchor.previousElementSibling;
	let point = anchor;
	for (
		let el = anchor;
		el && el !== card && card.contains(el);
		el = el.parentElement
	) {
		if (el.getAttribute("aria-hidden") === "true") point = el;
	}
	return point;
}

/**
 * Contrôleur des icônes de cartes sur une page de résultats : lit l'accès une
 * fois par page, pose une icône par carte et garde l'état du scan de chaque
 * annonce (par `externalId`), qui survit au remontage de son icône. Aucun scan
 * sans clic.
 */
export function createCardController(deps: CardControllerDeps): {
	refresh(): Promise<void>;
	dispose(): void;
} {
	const { doc } = deps;
	const log = deps.log ?? ((msg: string) => console.debug(msg));
	const scan = deps.scan ?? scanCard;
	const fetchPage = deps.fetchPage ?? defaultFetchPage;
	const win = deps.win === undefined ? doc.defaultView : deps.win;
	const tracked = new Map<string, Tracked>();
	const states = new Map<string, ScanState>();
	/** Accès lu pour l'URL `href` ; `value` null : lecture en échec. */
	let access: { href: string; value: ContentAccess | null } | null = null;
	/** Incrémenté à chaque invalidation : une lecture plus ancienne est ignorée. */
	let accessGen = 0;
	/** Début de la dernière lecture de l'accès (`Date.now()`). */
	let accessReadAt = 0;
	/** Remontages après un hôte retiré, par annonce, pour l'URL `remountsUrl`. */
	const remounts = new Map<string, number>();
	let remountsUrl = "";
	let onSearch = false;
	let locale: Locale = "fr";
	let disposed = false;
	const loggedErrors = new Set<string>();
	let stepUrl = "";
	let queue: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const stateOf = (id: string) => states.get(id) ?? IDLE;
	const viewOf = (id: string): CardView => ({
		state: stateOf(id),
		locale,
		onActivate: () => activate(id),
	});

	function unmountCard(id: string) {
		const entry = tracked.get(id);
		if (!entry) return;
		tracked.delete(id);
		if (entry.card.element.getAttribute(MARK_ATTR) === id)
			entry.card.element.removeAttribute(MARK_ATTR);
		entry.mount.unmount();
	}

	function clearAll() {
		for (const id of [...tracked.keys()]) unmountCard(id);
	}

	function invalidateAccess() {
		accessGen++;
		access = null;
	}

	function setState(id: string, state: ScanState) {
		states.set(id, state);
		tracked.get(id)?.mount.update(viewOf(id));
	}

	function activate(id: string) {
		const entry = tracked.get(id);
		const status = stateOf(id).status;
		// En cours : double clic ignoré. Terminé : l'infobulle montre déjà le résultat.
		if (disposed || !entry || status === "loading" || status === "done") return;
		const pageUrl = deps.getUrl();
		const adapter = adapterFor(pageUrl);
		if (!adapter) return;
		setState(id, { status: "loading" });
		void scan(entry.card, { pageUrl, adapter, ai: deps.ai, fetchPage })
			.then(
				(response): ScanState =>
					response.ok
						? { status: "done", result: response.data }
						: { status: "error", code: response.error.code },
				(): ScanState => ({ status: "error", code: "background_unavailable" }),
			)
			.then((state) => {
				if (disposed) return;
				setState(id, state);
				if (state.status === "error" && RELOGIN_CODES.has(state.code)) {
					invalidateAccess();
					void refresh();
				}
			});
	}

	async function readAccess(): Promise<ContentAccess | null> {
		try {
			const response = await deps.ai.access();
			return response.ok ? response.data : null;
		} catch {
			return null;
		}
	}

	async function step() {
		const url = deps.getUrl();
		stepUrl = url.href;
		const adapter = adapterFor(url);
		const site = adapter?.siteOf(url);
		// R7 : fiche en modale sur la grille, qui reste visible à sa fermeture.
		// Les icônes restent telles quelles : ni retrait, ni nouveau montage.
		if (adapter?.isOverlayListing?.(doc, url)) return;
		if (!adapter || !site || adapter.pageType(url, doc) !== "search") {
			onSearch = false;
			invalidateAccess();
			clearAll();
			return;
		}
		onSearch = true;
		if (remountsUrl !== url.href) {
			remountsUrl = url.href;
			remounts.clear();
		}

		if (access?.href !== url.href) {
			const gen = accessGen;
			accessReadAt = Date.now();
			const value = await readAccess();
			// Page changée ou accès invalidé pendant la lecture : un autre passage suit.
			if (disposed || gen !== accessGen || deps.getUrl().href !== url.href)
				return;
			access = { href: url.href, value };
		}
		if (!access.value || !canUse(access.value, "cards")) {
			clearAll();
			// Une erreur de session ne doit pas rester affichée après reconnexion.
			for (const [id, state] of states)
				if (state.status === "error") states.delete(id);
			return;
		}

		// Lue à chaque passage : un changement de langue atteint les icônes montées.
		const nextLocale = await deps.getLocale(site);
		if (disposed || deps.getUrl().href !== url.href) return;
		const localeChanged = nextLocale !== locale;
		locale = nextLocale;

		const seen = new Set<string>();
		for (const card of adapter.findCards(doc, url)) {
			const id = card.externalId;
			seen.add(id);
			const anchor = mountPointOf(adapter, card.element);
			const entry = tracked.get(id);
			const samePlace =
				entry?.card.element === card.element && entry.anchor === anchor;
			if (entry && samePlace && entry.mount.isMounted()) {
				entry.card = card;
				if (localeChanged) entry.mount.update(viewOf(id));
				continue;
			}
			if (entry && samePlace) {
				// Le site retire notre hôte à chaque rendu : on cesse après 3 essais.
				// Un changement de carte ou d'ancre (R4) n'est pas limité.
				const count = remounts.get(id) ?? 0;
				if (count >= MAX_REMOUNTS) {
					entry.card = card;
					continue;
				}
				remounts.set(id, count + 1);
			}
			// Hôte perdu, carte recréée ou ancre changée (autre mise en page) : remontage.
			unmountCard(id);
			if (!anchor?.parentElement) continue;
			// Déjà montée pour cette annonce par une autre instance du script.
			if (card.element.getAttribute(MARK_ATTR) === id) continue;
			card.element.setAttribute(MARK_ATTR, id);
			tracked.set(id, {
				card,
				anchor,
				mount: deps.mountCard(anchor, card, viewOf(id)),
			});
		}
		// Cartes retirées par le site (virtualisation) : leur état reste, pour leur retour.
		for (const id of [...tracked.keys()]) if (!seen.has(id)) unmountCard(id);
	}

	/** Les passages s'exécutent l'un après l'autre, jamais en parallèle. */
	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		queue = queue
			.then(() => (disposed ? undefined : step()))
			.catch((error: unknown) => {
				if (loggedErrors.has(stepUrl)) return;
				loggedErrors.add(stepUrl);
				log(`radarnaque: ${String(error)}`);
			});
		return queue;
	}

	/** R5 : accès inactif sur une page de résultats, relu au retour sur l'onglet. */
	function recheckInactiveAccess() {
		if (disposed || !onSearch || !access) return;
		const status = access.value?.status;
		if (status === "active") return;
		// signedOut : réponse locale du service worker, relue sans délai. Sinon
		// (`noSubscription`, erreur), chaque relecture coûte un appel à l'API.
		if (status !== "signedOut" && Date.now() - accessReadAt < RECHECK_MS)
			return;
		invalidateAccess();
		void refresh();
	}
	const onFocus = () => recheckInactiveAccess();
	const onVisibility = () => {
		if (doc.visibilityState === "visible") recheckInactiveAccess();
	};
	win?.addEventListener("focus", onFocus);
	doc.addEventListener("visibilitychange", onVisibility);

	// Une mutation (ou un `href` reçu tard, à l'hydratation) planifie un passage
	// dans 250 ms ; celles qui suivent sont couvertes par ce passage.
	const observer = new MutationObserver((records) => {
		if (disposed || timer !== undefined) return;
		if (records.every(isOwnInsertion)) return;
		timer = setTimeout(() => {
			timer = undefined;
			void refresh();
		}, THROTTLE_MS);
	});
	observer.observe(doc.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["href"],
	});

	function dispose() {
		if (disposed) return;
		disposed = true;
		observer.disconnect();
		clearTimeout(timer);
		timer = undefined;
		win?.removeEventListener("focus", onFocus);
		doc.removeEventListener("visibilitychange", onVisibility);
		clearAll();
	}

	return { refresh, dispose };
}
