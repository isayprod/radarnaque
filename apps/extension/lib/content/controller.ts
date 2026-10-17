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
	update(report: RiskReport): void;
	unmount(): void;
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
	/** Score et identifiants des signaux : un changement entraîne `update`. */
	key: string;
}

const reportKey = (report: RiskReport) =>
	`${report.score}|${report.signals.map((s) => s.id).join(",")}`;

const isOwnUi = (node: Node) =>
	node.nodeType === Node.ELEMENT_NODE &&
	(node as Element).localName === BADGE_HOST_TAG;

/** Mutation entièrement due à l'insertion ou au retrait de notre hôte. */
function isOwnMutation(record: MutationRecord): boolean {
	const nodes = [...record.addedNodes, ...record.removedNodes];
	return nodes.length > 0 && nodes.every(isOwnUi);
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
		const key = reportKey(report);

		if (current?.anchor === anchor && current.externalId === externalId) {
			if (current.key !== key) {
				current.key = key;
				mounter.update(report);
			}
			return;
		}

		clear();
		// Déjà montée pour cette annonce par une autre instance du script.
		if (anchor.getAttribute(MARK_ATTR) === externalId) return;
		const locale = await deps.getLocale(site);
		if (disposed) return;
		anchor.setAttribute(MARK_ATTR, externalId);
		current = { anchor, externalId, key };
		mounter.mount(anchor, report, locale);
	}

	/** Les passages s'exécutent l'un après l'autre, jamais en parallèle. */
	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		queue = queue
			.then(() => (disposed ? undefined : step()))
			.catch((error: unknown) => log(`radarnaque: ${String(error)}`));
		return queue;
	}

	// Une mutation planifie un passage dans 250 ms ; celles qui suivent sont
	// couvertes par ce passage, et toute mutation ultérieure en planifie un autre.
	const observer = new MutationObserver((records) => {
		if (disposed || timer !== undefined) return;
		if (records.every(isOwnMutation)) return;
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
