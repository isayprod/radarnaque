import type { Locale } from "@radarnaque/shared";
import { adapterFor } from "../adapters/registry";
import type { Site } from "../listing/types";
import { evaluate, type RiskReport, type UnknownField } from "../rules/score";

/** Balise de l'hôte du shadow root de la pastille (nom passé à `createShadowRootUi`). */
export const BADGE_HOST_TAG = "radarnaque-badge";

/** Attribut posé sur l'ancre : la pastille de cette annonce y est déjà montée. */
const MARK_ATTR = "data-radarnaque";

/** Les mutations du DOM déclenchent au plus un `refresh` toutes les 250 ms. */
const THROTTLE_MS = 250;

const UNKNOWN_FIELDS: ReadonlySet<string> = new Set<UnknownField>([
	"description",
	"images",
]);

export interface Mounter {
	mount(anchor: Element, report: RiskReport, locale: Locale): void;
	/** Nouveau rendu de la pastille montée (rapport ou langue changés), sans remontage. */
	update(report: RiskReport, locale: Locale): void;
	unmount(): void;
	/** Vrai tant que la pastille est montée (ou en cours de montage) dans le document. */
	isMounted(): boolean;
}

export interface ControllerDeps {
	doc: Document;
	getUrl(): URL;
	mounter: Mounter;
	getLocale(site: Site): Promise<Locale>;
	log?: (msg: string) => void;
}

interface Mounted {
	anchor: Element;
	externalId: string;
	/** Score, identifiants des signaux et locale : un changement entraîne `update`. */
	key: string;
}

const mountedKey = (report: RiskReport, locale: Locale) =>
	`${report.score}|${report.signals.map((s) => s.id).join(",")}|${locale}`;

const isOwnUi = (node: Node) =>
	node.nodeType === Node.ELEMENT_NODE &&
	(node as Element).localName === BADGE_HOST_TAG;

/**
 * Mutation due uniquement à l'insertion de notre hôte. Un retrait reste
 * observé : s'il vient du site, la pastille doit être remontée.
 */
function isOwnInsertion(record: MutationRecord): boolean {
	return (
		record.removedNodes.length === 0 &&
		record.addedNodes.length > 0 &&
		[...record.addedNodes].every(isOwnUi)
	);
}

/**
 * Contrôleur de page : détecte la fiche, l'extrait, l'évalue et monte, met à
 * jour ou retire la pastille. Idempotent ; observe `doc.body` dès sa création.
 */
export function createController(deps: ControllerDeps): {
	refresh(): Promise<void>;
	dispose(): void;
} {
	const { doc, mounter } = deps;
	const log = deps.log ?? ((msg: string) => console.debug(msg));
	let current: Mounted | null = null;
	let disposed = false;
	/** URL dont l'échec d'extraction a déjà été journalisé. */
	let loggedFailure: string | null = null;
	/** URL pour laquelle une pastille perdue a déjà été remontée (une fois au plus). */
	let remountedUrl: string | null = null;
	/** URL dont une erreur de `refresh` a déjà été journalisée. */
	const loggedErrors = new Set<string>();
	/** URL du passage en cours, pour journaliser ses erreurs. */
	let stepUrl = "";
	let queue: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clear() {
		if (!current) return;
		current.anchor.removeAttribute(MARK_ATTR);
		current = null;
		mounter.unmount();
	}

	async function step() {
		const url = deps.getUrl();
		stepUrl = url.href;
		const adapter = adapterFor(url);
		if (adapter?.pageType(url, doc) !== "listing") {
			loggedFailure = null;
			clear();
			return;
		}

		const result = adapter.extractListing(doc, url);
		const root = result ? adapter.listingRoot(doc, url) : null;
		const anchor = root ? adapter.badgeAnchor(root) : null;
		if (!result || !anchor) {
			clear();
			if (loggedFailure !== url.href) {
				loggedFailure = url.href;
				log(`radarnaque: extraction impossible (${adapter.id})`);
			}
			return;
		}
		loggedFailure = null;

		const unknown = new Set(
			result.missing.filter((f): f is UnknownField => UNKNOWN_FIELDS.has(f)),
		);
		const report = evaluate(result.listing, { unknown });
		const { externalId, site } = result.listing;
		// Lue à chaque passage : un changement de langue dans la popup doit
		// atteindre une pastille déjà montée.
		const locale = await deps.getLocale(site);
		// Pendant l'attente, la page a pu passer à une autre annonce.
		if (disposed || deps.getUrl().href !== url.href || !anchor.isConnected)
			return;
		const key = mountedKey(report, locale);

		if (current?.anchor === anchor && current.externalId === externalId) {
			if (mounter.isMounted()) {
				if (current.key !== key) {
					current.key = key;
					mounter.update(report, locale);
				}
				return;
			}
			// Pastille perdue (hôte retiré par le site, ou montage en échec) : une
			// seule nouvelle tentative par URL, pour ne pas boucler.
			if (remountedUrl === url.href) return;
			remountedUrl = url.href;
		}

		clear();
		// Déjà montée pour cette annonce par une autre instance du script.
		if (anchor.getAttribute(MARK_ATTR) === externalId) return;
		anchor.setAttribute(MARK_ATTR, externalId);
		current = { anchor, externalId, key };
		mounter.mount(anchor, report, locale);
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

	// Une mutation planifie un passage dans 250 ms ; celles qui suivent sont
	// couvertes par ce passage, et toute mutation ultérieure en planifie un autre.
	const observer = new MutationObserver((records) => {
		if (disposed || timer !== undefined) return;
		if (records.every(isOwnInsertion)) return;
		timer = setTimeout(() => {
			timer = undefined;
			void refresh();
		}, THROTTLE_MS);
	});
	observer.observe(doc.body, { childList: true, subtree: true });

	function dispose() {
		if (disposed) return;
		disposed = true;
		observer.disconnect();
		clearTimeout(timer);
		timer = undefined;
		clear();
	}

	return { refresh, dispose };
}
