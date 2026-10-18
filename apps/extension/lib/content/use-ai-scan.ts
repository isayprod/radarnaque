import type { Locale } from "@radarnaque/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiSectionProps } from "../../components/AiSection";
import { PUBLIC_URL } from "../config";
import type { ScanKind, ScanRequest } from "../messages";
import {
	type AccessCache,
	type AccessReading,
	createAccessCache,
	RELOGIN_CODES,
} from "./access-policy";
import type { AiClient, ScanState } from "./ai-client";
import {
	type AiResultStore,
	listingFingerprint,
	type StoredAiResults,
	withoutRemaining,
} from "./ai-results";
import type { BadgeView } from "./controller";

export type { BadgeView } from "./controller";

type AccessState = AiSectionProps["access"];

/** États de la section IA, liés à une annonce par `key`. */
interface Slots {
	key: string;
	/** `null` : accès pas encore chargé pour cette annonce. */
	access: AccessState | null;
	text: ScanState;
	image: ScanState;
	/**
	 * Empreinte de l'annonce analysée (ou restaurée) pour chaque état `done`.
	 * L'annonce affichée change sous la même clé (prix, description) : l'état
	 * revient à `idle` et la pastille à l'analyse locale (I2).
	 */
	doneFingerprint: Partial<Record<ScanKind, string>>;
	loginUnavailable: boolean;
}

/**
 * Portée des requêtes d'une annonce. Remplacée quand la clé change : toute
 * réponse arrivée pour une ancienne portée est ignorée.
 */
interface Scope {
	key: string;
	inflight: Set<ScanKind>;
	/** Une lecture de l'accès est en cours. */
	reading: boolean;
	/** Numéro de la dernière lecture de l'accès : seules ses réponses comptent. */
	accessSeq: number;
	/** Le magasin des résultats IA a déjà été lu pour cette annonce. */
	storeRead: boolean;
}

const IDLE: ScanState = { status: "idle" };

const KINDS: readonly ScanKind[] = ["text", "image"];

const freshSlots = (key: string, access: AccessState | null): Slots => ({
	key,
	access,
	text: IDLE,
	image: IDLE,
	doneFingerprint: {},
	loginUnavailable: false,
});

/** Les états `done` d'une autre version de l'annonce reviennent à `idle` (I2). */
function dropStale(slots: Slots, fingerprint: string): Slots {
	let next = slots;
	for (const kind of KINDS) {
		if (
			next[kind].status !== "done" ||
			next.doneFingerprint[kind] === fingerprint
		)
			continue;
		const { [kind]: _, ...others } = next.doneFingerprint;
		next = { ...next, [kind]: IDLE, doneFingerprint: others };
	}
	return next;
}

const freshScope = (key: string): Scope => ({
	key,
	inflight: new Set(),
	reading: false,
	accessSeq: 0,
	storeRead: false,
});

const keyOf = (view: BadgeView) =>
	`${view.listing.site}|${view.listing.externalId}`;

export interface AiScan {
	access: AccessState;
	text: ScanState;
	image: ScanState;
	loginUnavailable: boolean;
	pricingUrl: string;
	/**
	 * Lit l'accès si la politique R8 le demande (signedOut : toujours ;
	 * noSubscription, erreur : 30 s ; active : 5 min) et qu'aucune lecture
	 * n'est en cours ; sinon affiche l'accès en cache. Appelée à l'ouverture du
	 * panneau et au retour sur l'onglet : après une connexion dans la popup, le
	 * panneau passe à `active` sans rechargement.
	 */
	loadAccess(): void;
	scan(kind: ScanKind): void;
	login(): void;
}

/**
 * État des analyses IA de la pastille. Il vit dans le composant de la pastille :
 * fermer le panneau ne le perd pas. Aucun scan n'est lancé sans appel à `scan`.
 * L'accès vient de `accessCache`, partagé avec les icônes de cartes et gardé
 * d'une annonce à l'autre (R8) ; à défaut, un cache propre à la pastille.
 *
 * `aiResults` garde les résultats 24 h : à l'arrivée sur une annonce, un
 * résultat complet dont l'empreinte est celle de l'annonce affichée est repris
 * sans nouveau scan. Une annonce modifiée, ou un résultat partiel venu d'une
 * carte, laisse la pastille sur l'analyse locale.
 */
export function useAiScan(
	client: AiClient,
	view: BadgeView,
	locale: Locale,
	accessCache?: AccessCache,
	aiResults?: AiResultStore,
): AiScan {
	const [ownCache] = useState(createAccessCache);
	const cache = accessCache ?? ownCache;
	const key = keyOf(view);
	const [stored, setSlots] = useState<Slots>(() =>
		freshSlots(key, cache.current()),
	);
	const scopeRef = useRef<Scope>(freshScope(key));
	// Nouvelle annonce : nouvelle portée, les réponses de l'ancienne sont ignorées.
	if (scopeRef.current.key !== key) scopeRef.current = freshScope(key);
	// Et retour immédiat à l'état initial, sans un rendu avec l'ancien résultat.
	// L'accès en cache reste affiché : il ne dépend pas de l'annonce.
	let slots = stored;
	if (stored.key !== key) {
		slots = freshSlots(key, cache.current());
		setSlots(slots);
	}
	// Même annonce, autre version (prix, description…) : l'ancien verdict IA
	// n'est plus affiché, sans un rendu avec lui.
	const fingerprint = listingFingerprint(view.listing);
	if (dropStale(slots, fingerprint) !== slots) {
		slots = dropStale(slots, fingerprint);
		setSlots((prev) => dropStale(prev, fingerprint));
	}

	// L'annonce et le rapport les plus récents, lus au moment du clic.
	const viewRef = useRef(view);
	viewRef.current = view;

	// Faux après le démontage : plus aucun état ni aucune requête. Remis à vrai
	// à chaque montage, y compris le second montage du StrictMode.
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	/** Applique `patch` si le composant est monté et la portée toujours celle de l'annonce affichée. */
	const patch = useCallback((scope: Scope, update: Partial<Slots>) => {
		if (!mountedRef.current || scopeRef.current !== scope) return;
		setSlots((prev) =>
			prev.key === scope.key ? { ...prev, ...update } : prev,
		);
	}, []);

	/**
	 * État d'un type. Un `done` retient l'empreinte de l'annonce analysée ;
	 * `onlyIfIdle` : pas d'écrasement d'un scan en cours ou fini.
	 */
	const setKind = useCallback(
		(
			scope: Scope,
			kind: ScanKind,
			state: ScanState,
			analysed?: string,
			onlyIfIdle = false,
		) => {
			if (!mountedRef.current || scopeRef.current !== scope) return;
			setSlots((prev) => {
				if (prev.key !== scope.key) return prev;
				if (onlyIfIdle && prev[kind].status !== "idle") return prev;
				const { [kind]: _, ...others } = prev.doneFingerprint;
				const doneFingerprint =
					state.status === "done" && analysed !== undefined
						? { ...others, [kind]: analysed }
						: others;
				return { ...prev, [kind]: state, doneFingerprint };
			});
		},
		[],
	);

	// Une seule lecture du magasin par annonce (portée), jamais un scan.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` déclenche la lecture pour chaque annonce
	useEffect(() => {
		const scope = scopeRef.current;
		if (!aiResults || scope.storeRead) return;
		scope.storeRead = true;
		const { site, externalId } = viewRef.current.listing;
		const adopt = (entries: StoredAiResults | null) => {
			if (!entries) return;
			const current = listingFingerprint(viewRef.current.listing);
			// Chaque type est repris seul (R4).
			for (const kind of KINDS) {
				const entry = entries[kind];
				// Résultat partiel (carte) ou annonce changée depuis l'analyse : pastille locale.
				if (!entry || entry.result.partial || entry.fingerprint !== current)
					continue;
				// I1 : jamais le quota restant de l'époque. Un scan de ce type, en
				// cours ou fini (pas `idle`), l'emporte sur l'entrée lue.
				setKind(
					scope,
					kind,
					{ status: "done", result: withoutRemaining(entry.result) },
					entry.fingerprint,
					true,
				);
			}
		};
		void aiResults.get(site, externalId).then(adopt, () => {});
	}, [aiResults, key, setKind]);

	const readAccess = useCallback(
		(scope: Scope) => {
			if (!mountedRef.current) return;
			const seq = ++scope.accessSeq;
			scope.reading = true;
			const ticket = cache.begin();
			// L'accès précédent reste affiché pendant la lecture : pas de « Chargement… ».
			const settle = (access: AccessReading) => {
				cache.settle(ticket, access);
				if (scope.accessSeq !== seq) return;
				scope.reading = false;
				patch(scope, { access });
			};
			void client.access().then(
				(response) =>
					settle(response.ok ? response.data : { error: response.error.code }),
				() => settle({ error: "background_unavailable" }),
			);
		},
		[client, patch, cache],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` renouvelle la fonction à chaque annonce
	const loadAccess = useCallback(() => {
		const scope = scopeRef.current;
		if (scope.reading) return;
		if (cache.needsRead()) {
			readAccess(scope);
			return;
		}
		// Accès encore valable, peut-être lu ailleurs (icônes de cartes).
		const access = cache.current();
		if (access) patch(scope, { access });
	}, [readAccess, patch, cache, key]);

	const scan = useCallback(
		(kind: ScanKind) => {
			const scope = scopeRef.current;
			// Un scan en cours pour ce type : pas de second (double clic).
			if (scope.inflight.has(kind)) return;
			scope.inflight.add(kind);
			const { listing, report } = viewRef.current;
			const request: ScanRequest = {
				listing,
				signals: report.signals,
				rulesVersion: report.rulesVersion,
				scanKind: kind,
				trigger: "button",
				// Fiche lue en entier : `partial` ne vaut vrai que pour un scan depuis une carte.
				partial: false,
			};
			const analysed = listingFingerprint(listing);
			setKind(scope, kind, { status: "loading" });
			const finish = (state: ScanState) => {
				scope.inflight.delete(kind);
				// Gardé 24 h, même si l'annonce affichée a changé entre-temps :
				// l'entrée porte l'empreinte de l'annonce lue au clic.
				if (state.status === "done")
					void aiResults
						?.put(listing.site, listing.externalId, {
							result: state.result,
							scanKind: kind,
							fingerprint: analysed,
							storedAt: Date.now(),
						})
						.catch(() => {});
				// Annonce modifiée depuis le clic : le rendu suivant le remet à `idle`.
				setKind(scope, kind, state, analysed);
				// R8 : session expirée, l'accès en cache ne vaut plus, pour les
				// icônes de cartes aussi.
				if (state.status === "error" && RELOGIN_CODES.has(state.code))
					cache.invalidate();
				// Quota consommé, session expirée (R3 : l'accès relu dit alors signedOut) :
				// l'accès est relu après chaque scan, réussi ou non, même actif en cache.
				if (mountedRef.current && scopeRef.current === scope) readAccess(scope);
			};
			void client.scan(request).then(
				(response) =>
					finish(
						response.ok
							? { status: "done", result: response.data }
							: { status: "error", code: response.error.code },
					),
				() => finish({ status: "error", code: "background_unavailable" }),
			);
		},
		[client, setKind, readAccess, cache, aiResults],
	);

	const login = useCallback(() => {
		const scope = scopeRef.current;
		void client.openLogin().then(
			(response) => {
				patch(scope, { loginUnavailable: !response.ok });
			},
			() => patch(scope, { loginUnavailable: true }),
		);
	}, [client, patch]);

	return {
		access: slots.access ?? "loading",
		text: slots.text,
		image: slots.image,
		loginUnavailable: slots.loginUnavailable,
		pricingUrl: `${PUBLIC_URL}/pricing/?lang=${locale}`,
		loadAccess,
		scan,
		login,
	};
}
