import type { Locale, ScanProgressEvent } from "@radarnaque/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiSectionProps } from "../../components/AiSection";
import { PUBLIC_URL } from "../config";
import type { DebugLog } from "../debug-log";
import type { ScanRequest } from "../messages";
import {
	type AccessCache,
	type AccessReading,
	createAccessCache,
	RELOGIN_CODES,
} from "./access-policy";
import {
	type AiClient,
	CANCELLED,
	type ScanHandle,
	type ScanState,
	scanOutcome,
} from "./ai-client";
import {
	type AiResultStore,
	listingFingerprint,
	type StoredAiResult,
	withoutRemaining,
} from "./ai-results";
import type { BadgeView } from "./controller";
import { addEvent, startProgress } from "./scan-progress";

export type { BadgeView } from "./controller";

type AccessState = AiSectionProps["access"];

/** État de la section IA, lié à une annonce par `key`. */
interface Slots {
	key: string;
	/** `null` : accès pas encore chargé pour cette annonce. */
	access: AccessState | null;
	/** L'analyse IA de l'annonce : une seule place (`full`). */
	ai: ScanState;
	/**
	 * Empreinte de l'annonce analysée (ou restaurée) pour l'état `done`.
	 * L'annonce affichée change sous la même clé (prix, description) : l'état
	 * revient à `idle` et la pastille à l'analyse locale (I2).
	 */
	doneFingerprint: string | null;
	/**
	 * Relance sans cache en cours (superuser) : le résultat affiché reste en
	 * place, seul le bouton de la section Debug l'indique.
	 */
	rescanning: boolean;
	/**
	 * Code d'erreur de la dernière relance sans cache : le résultat affiché
	 * reste en place et l'erreur s'affiche dans la section Debug.
	 */
	rescanError: string | null;
	loginUnavailable: boolean;
}

/**
 * Portée des requêtes d'une annonce. Remplacée quand la clé change : toute
 * réponse ou tout événement arrivé pour une ancienne portée est ignoré.
 */
interface Scope {
	key: string;
	/**
	 * Analyse en cours (une à la fois) : annulée au changement d'annonce et au
	 * démontage, ce qui ferme son port et rend le scan côté serveur.
	 */
	inflight: ScanHandle | null;
	/** Une lecture de l'accès est en cours. */
	reading: boolean;
	/** Numéro de la dernière lecture de l'accès : seules ses réponses comptent. */
	accessSeq: number;
	/** Le magasin des résultats IA a déjà été lu pour cette annonce. */
	storeRead: boolean;
}

const IDLE: ScanState = { status: "idle" };

const freshSlots = (key: string, access: AccessState | null): Slots => ({
	key,
	access,
	ai: IDLE,
	doneFingerprint: null,
	rescanning: false,
	rescanError: null,
	loginUnavailable: false,
});

/** Un état `done` d'une autre version de l'annonce revient à `idle` (I2). */
function dropStale(slots: Slots, fingerprint: string): Slots {
	if (slots.ai.status !== "done" || slots.doneFingerprint === fingerprint)
		return slots;
	return { ...slots, ai: IDLE, doneFingerprint: null };
}

const freshScope = (key: string): Scope => ({
	key,
	inflight: null,
	reading: false,
	accessSeq: 0,
	storeRead: false,
});

const keyOf = (view: BadgeView) =>
	`${view.listing.site}|${view.listing.externalId}`;

export interface AiScan {
	access: AccessState;
	/** L'analyse IA : `loading` porte la progression en direct, `done` la garde. */
	ai: ScanState;
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
	scan(): void;
	/**
	 * Superuser : relance l'analyse avec `noCache: true`. Le résultat affiché
	 * reste en place pendant la relance (`rescanning`) ; il est remplacé par un
	 * nouveau résultat, ou gardé en cas d'erreur (`rescanError`).
	 */
	rescan(): void;
	/** Une relance sans cache est en cours. */
	rescanning: boolean;
	/** Code d'erreur de la dernière relance ; effacé à la suivante. */
	rescanError: string | null;
	login(): void;
}

/**
 * État de l'analyse IA de la pastille. Il vit dans le composant de la pastille :
 * fermer le panneau ne le perd pas. Aucun scan n'est lancé sans appel à `scan`.
 * L'accès vient de `accessCache`, partagé avec les icônes de cartes et gardé
 * d'une annonce à l'autre (R8) ; à défaut, un cache propre à la pastille.
 *
 * Pendant l'analyse, chaque événement du flux met à jour la progression. Une autre
 * annonce (navigation sans rechargement) ou le démontage annule l'analyse en
 * cours : son port est fermé, et ses derniers événements sont ignorés.
 *
 * `aiResults` garde les résultats 24 h : à l'arrivée sur une annonce, un
 * résultat complet dont l'empreinte est celle de l'annonce affichée est repris
 * sans nouveau scan. Une annonce modifiée, ou un résultat partiel venu d'une
 * carte, laisse la pastille sur l'analyse locale.
 *
 * `debugLog` (superuser) reçoit chaque requête envoyée et chaque réponse.
 */
export function useAiScan(
	client: AiClient,
	view: BadgeView,
	locale: Locale,
	accessCache?: AccessCache,
	aiResults?: AiResultStore,
	debugLog?: DebugLog,
): AiScan {
	const [ownCache] = useState(createAccessCache);
	const cache = accessCache ?? ownCache;
	const key = keyOf(view);
	const [stored, setSlots] = useState<Slots>(() =>
		freshSlots(key, cache.current()),
	);
	const scopeRef = useRef<Scope>(freshScope(key));
	// Nouvelle annonce : nouvelle portée, les réponses de l'ancienne sont ignorées.
	// Son analyse en cours est annulée par l'effet de portée, ci-dessous.
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
	const fresh = dropStale(slots, fingerprint);
	if (fresh !== slots) {
		slots = fresh;
		// Appliqué à l'état le plus récent, qui peut différer de celui de ce rendu.
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

	// Point 4 de Review Focus : l'analyse de l'annonce quittée (nouvelle clé) ou
	// du composant démonté est annulée. Le port fermé, le service worker annule la
	// requête et le serveur rend le scan.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` délimite la portée dont l'analyse est annulée
	useEffect(() => {
		const scope = scopeRef.current;
		return () => {
			scope.inflight?.cancel();
			scope.inflight = null;
		};
	}, [key]);

	/** Vrai si le composant est monté et la portée toujours celle de l'annonce affichée. */
	const current = useCallback(
		(scope: Scope) => mountedRef.current && scopeRef.current === scope,
		[],
	);

	/** Applique `update` à l'état de la portée, si elle est toujours celle affichée. */
	const patch = useCallback(
		(scope: Scope, update: (prev: Slots) => Slots) => {
			if (!current(scope)) return;
			setSlots((prev) => (prev.key === scope.key ? update(prev) : prev));
		},
		[current],
	);

	/**
	 * État de l'analyse. Un `done` retient l'empreinte de l'annonce analysée ;
	 * `onlyIfIdle` : pas d'écrasement d'un scan en cours ou fini. Un nouvel état
	 * met fin à la relance sans cache.
	 */
	const setAi = useCallback(
		(scope: Scope, state: ScanState, analysed?: string, onlyIfIdle = false) =>
			patch(scope, (prev) =>
				onlyIfIdle && prev.ai.status !== "idle"
					? prev
					: {
							...prev,
							ai: state,
							doneFingerprint:
								state.status === "done" && analysed !== undefined
									? analysed
									: null,
							rescanning: false,
							rescanError: null,
						},
			),
		[patch],
	);

	// Une seule lecture du magasin par annonce (portée), jamais un scan.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` déclenche la lecture pour chaque annonce
	useEffect(() => {
		const scope = scopeRef.current;
		if (!aiResults || scope.storeRead) return;
		scope.storeRead = true;
		const { site, externalId } = viewRef.current.listing;
		const adopt = (entry: StoredAiResult | null) => {
			const current = listingFingerprint(viewRef.current.listing);
			// Résultat partiel (carte) ou annonce changée depuis l'analyse : pastille locale.
			if (!entry || entry.result.partial || entry.fingerprint !== current)
				return;
			// I1 : jamais le quota restant de l'époque. Un scan en cours ou fini
			// (pas `idle`) l'emporte sur l'entrée lue. Aucun déroulé n'est gardé.
			setAi(
				scope,
				{
					status: "done",
					result: withoutRemaining(entry.result),
					progress: null,
				},
				entry.fingerprint,
				true,
			);
		};
		void aiResults.get(site, externalId).then(adopt, () => {});
	}, [aiResults, key, setAi]);

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
				patch(scope, (prev) => ({ ...prev, access }));
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
		if (access) patch(scope, (prev) => ({ ...prev, access }));
	}, [readAccess, patch, cache, key]);

	const run = useCallback(
		(noCache: boolean) => {
			const scope = scopeRef.current;
			// Une analyse en cours (scan ou relance) : pas de seconde (double clic).
			if (scope.inflight || !current(scope)) return;
			const { listing, report } = viewRef.current;
			const request: ScanRequest = {
				listing,
				signals: report.signals,
				rulesVersion: report.rulesVersion,
				trigger: "button",
				// Fiche lue en entier : `partial` ne vaut vrai que pour un scan depuis une carte.
				partial: false,
				// Clé absente d'un scan ordinaire : le serveur l'ignore de toute façon
				// pour un compte qui n'est pas superuser.
				...(noCache ? { noCache: true } : {}),
			};
			const analysed = listingFingerprint(listing);
			// Suivie ici, hors de l'état React : le résultat final la garde (déroulé
			// du panneau), y compris celui d'une relance.
			let progress = startProgress(Date.now());
			if (noCache) {
				// Relance : le résultat affiché reste en place (pas de retour à
				// l'analyse locale), seul le bouton de la section Debug change.
				patch(scope, (prev) => ({
					...prev,
					rescanning: true,
					rescanError: null,
				}));
			} else setAi(scope, { status: "loading", progress });
			debugLog?.group("scan demandé", request);

			const onEvent = (e: ScanProgressEvent) => {
				// Événement d'une annonce quittée, ou après le démontage : ignoré.
				if (!current(scope)) return;
				progress = addEvent(progress, e, Date.now());
				if (noCache) return;
				const loading: ScanState = { status: "loading", progress };
				patch(scope, (prev) =>
					prev.ai.status === "loading" ? { ...prev, ai: loading } : prev,
				);
			};
			const finish = (state: ScanState) => {
				if (scope.inflight === handle) scope.inflight = null;
				// Annulée (autre annonce, démontage) : ni état, ni log, ni écriture,
				// ni relecture de l'accès.
				if (state.status === "error" && state.code === CANCELLED) return;
				debugLog?.group("scan reçu", scanOutcome(state));
				// Gardé 24 h, même si l'annonce affichée a changé entre-temps :
				// l'entrée porte l'empreinte de l'annonce lue au clic.
				if (state.status === "done")
					void aiResults
						?.put(listing.site, listing.externalId, {
							result: state.result,
							fingerprint: analysed,
							storedAt: Date.now(),
						})
						.catch(() => {});
				// Relance en échec : le résultat affiché reste, l'erreur va à la
				// section Debug. Sinon (annonce modifiée depuis le clic), le rendu
				// suivant remet l'état à `idle`.
				if (noCache && state.status === "error") {
					const code = state.code;
					patch(scope, (prev) => ({
						...prev,
						rescanning: false,
						rescanError: code,
					}));
				} else setAi(scope, state, analysed);
				// R8 : session expirée, l'accès en cache ne vaut plus, pour les
				// icônes de cartes aussi.
				if (state.status === "error" && RELOGIN_CODES.has(state.code))
					cache.invalidate();
				// Quota consommé, session expirée (R3 : l'accès relu dit alors signedOut) :
				// l'accès est relu après chaque scan, réussi ou non, même actif en cache.
				if (current(scope)) readAccess(scope);
			};

			const handle = client.scan(request, onEvent);
			scope.inflight = handle;
			void handle.done.then(
				(response) =>
					finish(
						response.ok
							? { status: "done", result: response.data, progress }
							: { status: "error", code: response.error.code },
					),
				() => finish({ status: "error", code: "background_unavailable" }),
			);
		},
		[client, current, patch, setAi, readAccess, cache, aiResults, debugLog],
	);

	const scan = useCallback(() => run(false), [run]);
	const rescan = useCallback(() => run(true), [run]);

	const login = useCallback(() => {
		const scope = scopeRef.current;
		void client.openLogin().then(
			(response) => {
				const loginUnavailable = !response.ok;
				patch(scope, (prev) => ({ ...prev, loginUnavailable }));
			},
			() => patch(scope, (prev) => ({ ...prev, loginUnavailable: true })),
		);
	}, [client, patch]);

	return {
		access: slots.access ?? "loading",
		ai: slots.ai,
		loginUnavailable: slots.loginUnavailable,
		pricingUrl: `${PUBLIC_URL}/pricing/?lang=${locale}`,
		loadAccess,
		scan,
		rescan,
		rescanning: slots.rescanning,
		rescanError: slots.rescanError,
		login,
	};
}
