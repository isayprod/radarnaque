import type { Locale } from "@radarnaque/shared";
import { canUse } from "../access";
import { adapterFor } from "../adapters/registry";
import type { CardRef, MarketplaceAdapter } from "../adapters/types";
import type { Listing, Site } from "../listing/types";
import {
	type AccessCache,
	type AccessReading,
	createAccessCache,
	isContentAccess,
	RELOGIN_CODES,
} from "./access-policy";
import type { AiClient, ScanState } from "./ai-client";
import { type AiResultStore, listingFingerprint } from "./ai-results";
import { defaultFetchPage, scanCard } from "./card-scan";
import { BADGE_HOST_TAG, CARD_HOST_TAG } from "./controller";

export { CARD_HOST_TAG };

/** Attribut posé sur la carte : son icône y est déjà montée. */
const MARK_ATTR = "data-radarnaque-card";

/** Les mutations du DOM déclenchent au plus un `refresh` toutes les 250 ms. */
const THROTTLE_MS = 250;

/** Hôte retiré par le site, même carte et même ancre : remontages par annonce et par URL. */
const MAX_REMOUNTS = 3;

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
	/** Faux si l'hôte est masqué (variante de mise en page de la carte cachée). */
	isVisible(): boolean;
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
	/** Accès partagé avec la pastille de fiche (R8) ; un cache propre par défaut. */
	accessCache?: AccessCache;
	/** Résultats IA gardés 24 h, partagés avec la pastille ; aucun par défaut. */
	aiResults?: AiResultStore;
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
 * Contrôleur des icônes de cartes sur une page de résultats : lit l'accès selon
 * la politique R8 (cache partagé avec la pastille), pose une icône par carte et
 * garde l'état du scan de chaque annonce (par `externalId`), qui survit au
 * remontage de son icône. Aucun scan sans clic : un résultat gardé (`aiResults`)
 * est affiché tel quel, même partiel et quelle que soit son empreinte, car la
 * carte ne montre pas toute l'annonce.
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
	const accessCache = deps.accessCache ?? createAccessCache();
	/**
	 * URL pour laquelle l'accès en cache a été validé. Une nouvelle URL (ou un
	 * retour sur l'onglet, qui la vide) est l'occasion d'appliquer la politique
	 * R8 ; les passages déclenchés par les mutations ne relisent jamais l'accès.
	 */
	let checkedHref = "";
	/**
	 * R8 : carte dont le scan a répondu « session expirée ». Son icône reste,
	 * avec ce message, sur cette URL ; les autres sont retirées.
	 */
	let pinned: { id: string; href: string } | null = null;
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

	/** Carte épinglée retirée de l'épingle ; son erreur de session est oubliée. */
	function unpin(): string | null {
		if (!pinned) return null;
		const { id } = pinned;
		pinned = null;
		if (stateOf(id).status === "error") states.delete(id);
		return id;
	}

	function leaveSearch() {
		onSearch = false;
		// Budget de remontage neuf au retour, même sur la page de résultats quittée.
		remountsUrl = "";
		remounts.clear();
		unpin();
		clearAll();
	}

	function setState(id: string, state: ScanState) {
		states.set(id, state);
		tracked.get(id)?.mount.update(viewOf(id));
	}

	/** Icône montée ou remontée sans résultat : reprend celui du magasin s'il existe. */
	function restore(site: Site, id: string) {
		if (!deps.aiResults || stateOf(id).status !== "idle") return;
		void deps.aiResults.get(site, id).then(
			(stored) => {
				// Un clic entre-temps (chargement, résultat, erreur) l'emporte.
				if (disposed || !stored || stateOf(id).status !== "idle") return;
				setState(id, { status: "done", result: stored.result });
			},
			() => {},
		);
	}

	function activate(id: string) {
		const entry = tracked.get(id);
		const status = stateOf(id).status;
		// En cours : double clic ignoré. Terminé : l'infobulle montre déjà le résultat.
		if (disposed || !entry || status === "loading" || status === "done") return;
		const pageUrl = deps.getUrl();
		const adapter = adapterFor(pageUrl);
		const site = adapter?.siteOf(pageUrl);
		if (!adapter || !site) return;
		setState(id, { status: "loading" });
		let scanned: Listing | null = null;
		const onListing = (listing: Listing) => {
			scanned = listing;
		};
		void scan(entry.card, {
			pageUrl,
			adapter,
			ai: deps.ai,
			fetchPage,
			onListing,
		})
			.then(
				(response): ScanState =>
					response.ok
						? { status: "done", result: response.data }
						: { status: "error", code: response.error.code },
				(): ScanState => ({ status: "error", code: "background_unavailable" }),
			)
			.then((state) => {
				// Gardé 24 h avec l'empreinte de l'annonce analysée (fiche ou carte).
				if (state.status === "done" && scanned)
					void deps.aiResults
						?.put(site, id, {
							result: state.result,
							scanKind: "text",
							fingerprint: listingFingerprint(scanned),
							storedAt: Date.now(),
						})
						.catch(() => {});
				if (disposed) return;
				setState(id, state);
				if (state.status === "error" && RELOGIN_CODES.has(state.code)) {
					// R8 : accès oublié et relu sans délai ; l'icône cliquée garde
					// son message tant que l'URL ne change pas.
					accessCache.invalidate();
					pinned = { id, href: pageUrl.href };
					void refresh();
				}
			});
	}

	async function readAccess(): Promise<AccessReading> {
		try {
			const response = await deps.ai.access();
			return response.ok ? response.data : { error: response.error.code };
		} catch {
			return { error: "background_unavailable" };
		}
	}

	async function step() {
		const url = deps.getUrl();
		stepUrl = url.href;
		const adapter = adapterFor(url);
		const site = adapter?.siteOf(url);
		// Navigation : la carte épinglée après une session expirée est retirée.
		if (pinned && pinned.href !== url.href) {
			const id = unpin();
			if (id) unmountCard(id);
		}
		// R7 : fiche en modale sur la grille, qui reste visible à sa fermeture.
		// Les icônes restent telles quelles : ni retrait, ni nouveau montage.
		if (adapter?.isOverlayListing?.(doc, url)) return;
		if (!adapter || !site || adapter.pageType(url, doc) !== "search") {
			leaveSearch();
			return;
		}
		onSearch = true;
		if (remountsUrl !== url.href) {
			remountsUrl = url.href;
			remounts.clear();
		}

		if (
			accessCache.current() === null ||
			(checkedHref !== url.href && accessCache.needsRead())
		) {
			const ticket = accessCache.begin();
			const reading = await readAccess();
			accessCache.settle(ticket, reading);
			// Page changée pendant la lecture : un autre passage suit.
			if (disposed || deps.getUrl().href !== url.href) return;
		}
		const access = accessCache.current();
		// Accès invalidé pendant la lecture : le passage demandé par `activate` suit.
		if (access === null) return;
		checkedHref = url.href;
		if (!isContentAccess(access) || !canUse(access, "cards")) {
			for (const id of [...tracked.keys()])
				if (id !== pinned?.id) unmountCard(id);
			// Une erreur de session ne doit pas rester affichée après reconnexion.
			for (const [id, state] of states)
				if (state.status === "error" && id !== pinned?.id) states.delete(id);
			return;
		}
		// Accès retrouvé : la carte épinglée revient à l'état initial.
		const repinned = unpin();
		if (repinned) tracked.get(repinned)?.mount.update(viewOf(repinned));

		// Lue à chaque passage : un changement de langue atteint les icônes montées.
		const nextLocale = await deps.getLocale(site);
		if (disposed || deps.getUrl().href !== url.href) return;
		const localeChanged = nextLocale !== locale;
		locale = nextLocale;

		const seen = new Set<string>();
		for (const card of adapter.findCards(doc, url)) {
			const id = card.externalId;
			seen.add(id);
			const entry = tracked.get(id);
			// Icône montée et visible sur la même carte : l'ancre n'est pas
			// recalculée (coût par passage). Une icône masquée, dans une variante
			// de mise en page cachée après un redimensionnement (R4), est revue au
			// passage suivant, déclenché par une mutation.
			if (
				entry?.card.element === card.element &&
				entry.mount.isMounted() &&
				entry.mount.isVisible()
			) {
				entry.card = card;
				if (localeChanged) entry.mount.update(viewOf(id));
				continue;
			}
			const anchor = mountPointOf(adapter, card.element);
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
			restore(site, id);
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

	/**
	 * R5, R8 : sur une page de résultats, l'accès est relu au retour sur
	 * l'onglet si la politique le dit périmé (signedOut : toujours ;
	 * noSubscription, erreur : 30 s ; active : 5 min).
	 */
	function recheckAccess() {
		if (disposed || !onSearch || !accessCache.needsRead()) return;
		checkedHref = "";
		void refresh();
	}
	const onFocus = () => recheckAccess();
	const onVisibility = () => {
		if (doc.visibilityState === "visible") recheckAccess();
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
