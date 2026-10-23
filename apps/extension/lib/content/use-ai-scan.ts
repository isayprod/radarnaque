import type {
	IdentificationResult,
	Locale,
	ScanProgressEvent,
} from "@radarnaque/shared";
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
	type IdentifyHandle,
	type IdentifyState,
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
	 * revient à `idle` et la pastille à « Analyser » (I2).
	 */
	doneFingerprint: string | null;
	/** L'identification du produit : une seule place, à côté de l'analyse. */
	identification: IdentifyState;
	/** Empreinte de l'annonce identifiée pour l'état `done` (même règle que l'analyse). */
	identifiedFingerprint: string | null;
	/** L'identification `done` vient d'un « Identifier » de l'utilisateur. */
	identifiedByUser: boolean;
	/**
	 * « Analyser » demandé pendant l'identification : l'empreinte de l'annonce
	 * affichée au clic. La file ne vaut que tant que l'annonce affichée a cette
	 * empreinte.
	 */
	queuedFingerprint: string | null;
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
	/** Lecture du magasin des résultats IA en cours pour cette annonce. */
	restoring: boolean;
}

/**
 * Portée des requêtes d'une annonce. Remplacée quand la clé change : toute
 * réponse ou tout événement arrivé pour une ancienne portée est ignoré.
 */
interface Scope {
	key: string;
	/**
	 * Analyse ou identification en cours (une à la fois) : annulée au changement
	 * d'annonce et au démontage, ce qui ferme son port et rend le scan côté serveur.
	 */
	inflight: ScanHandle | IdentifyHandle | null;
	/**
	 * Identification en cours : l'empreinte de l'annonce identifiée ; null sinon.
	 * « Analyser » est alors mis en file.
	 */
	identifying: string | null;
	/**
	 * « Analyser » mis en file pendant l'identification : l'empreinte de l'annonce
	 * affichée au clic ; null sinon. La file part à la fin de l'identification si
	 * l'annonce affichée a toujours cette empreinte. La portée étant remplacée au
	 * changement d'annonce, la file d'une autre annonce est oubliée avec elle.
	 */
	queued: string | null;
	/** Une lecture de l'accès est en cours. */
	reading: boolean;
	/** Numéro de la dernière lecture de l'accès : seules ses réponses comptent. */
	accessSeq: number;
	/** Le magasin des résultats IA a déjà été lu pour cette annonce. */
	storeRead: boolean;
}

const IDLE: ScanState = { status: "idle" };
const IDENTIFY_IDLE: IdentifyState = { status: "idle" };

/** Étapes de l'identification dans le flux d'une analyse. */
const IDENTIFY_STAGES: ReadonlySet<string> = new Set([
	"reading_photos",
	"criteria",
	"identifying",
	"retrying",
]);

/**
 * Événement de progression de l'identification dans le flux d'une analyse : il
 * alimente la pilule « Identifier », pas le déroulé de l'analyse. Il ouvre la
 * phase d'identification du flux, que ferment `identification` et
 * `identification_error`.
 */
const isIdentifyProgress = (e: ScanProgressEvent): boolean =>
	e.type === "criteria_cached" ||
	e.type === "page_read" ||
	(e.type === "stage" && IDENTIFY_STAGES.has(e.stage));

/**
 * Événements communs aux deux pipelines : pendant la phase d'identification du
 * flux, ils vont au déroulé de l'identification ; sinon à celui de l'analyse.
 */
const SHARED_EVENTS: ReadonlySet<ScanProgressEvent["type"]> = new Set([
	"search",
	"search_done",
	"thinking",
]);

const freshSlots = (
	key: string,
	access: AccessState | null,
	restoring: boolean,
): Slots => ({
	key,
	access,
	ai: IDLE,
	doneFingerprint: null,
	identification: IDENTIFY_IDLE,
	identifiedFingerprint: null,
	identifiedByUser: false,
	queuedFingerprint: null,
	rescanning: false,
	rescanError: null,
	loginUnavailable: false,
	restoring,
});

/**
 * Un état `done` d'une autre version de l'annonce revient à `idle` (I2), pour
 * l'analyse comme pour l'identification ; la file d'« Analyser » est oubliée.
 */
function dropStale(slots: Slots, fingerprint: string): Slots {
	const staleAi =
		slots.ai.status === "done" && slots.doneFingerprint !== fingerprint;
	const staleIdentification =
		slots.identification.status === "done" &&
		slots.identifiedFingerprint !== fingerprint;
	const staleQueue =
		slots.queuedFingerprint !== null && slots.queuedFingerprint !== fingerprint;
	if (!staleAi && !staleIdentification && !staleQueue) return slots;
	return {
		...slots,
		...(staleAi ? { ai: IDLE, doneFingerprint: null } : {}),
		...(staleIdentification
			? {
					identification: IDENTIFY_IDLE,
					identifiedFingerprint: null,
					identifiedByUser: false,
				}
			: {}),
		...(staleQueue ? { queuedFingerprint: null } : {}),
	};
}

const freshScope = (key: string): Scope => ({
	key,
	inflight: null,
	identifying: null,
	queued: null,
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
	/**
	 * Lance l'analyse. Pendant une identification, elle est mise en file
	 * (`queued`) et part à la fin de l'identification, réussie ou non, si
	 * l'annonce affichée n'a pas changé depuis le clic.
	 */
	scan(): void;
	/** L'identification du produit : `loading` porte sa propre progression. */
	identification: IdentifyState;
	/**
	 * Lance l'identification seule ; rien si une identification ou une analyse
	 * est déjà en cours.
	 */
	identify(): void;
	/** « Analyser » demandé pendant une identification, en attente de sa fin. */
	queued: boolean;
	/**
	 * L'identification affichée vient d'un « Identifier » de l'utilisateur et
	 * aucune analyse n'est faite : l'analyse est incluse avec l'identification.
	 */
	analysisIncluded: boolean;
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
	/**
	 * Vrai de l'arrivée sur l'annonce jusqu'à la fin de la lecture du magasin
	 * (entrée trouvée ou non, lecture en échec) ; faux d'emblée sans magasin.
	 * Pendant ce temps, la pastille n'offre rien à cliquer : un « Analyser »
	 * lancerait un vrai scan sur une fiche déjà analysée.
	 */
	restoring: boolean;
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
 * carte, laisse la pastille sur « Analyser ».
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
		freshSlots(key, cache.current(), aiResults !== undefined),
	);
	const scopeRef = useRef<Scope>(freshScope(key));
	// Nouvelle annonce : nouvelle portée, les réponses de l'ancienne sont ignorées.
	// Son analyse en cours est annulée par l'effet de portée, ci-dessous.
	if (scopeRef.current.key !== key) scopeRef.current = freshScope(key);
	// Et retour immédiat à l'état initial, sans un rendu avec l'ancien résultat.
	// L'accès en cache reste affiché : il ne dépend pas de l'annonce.
	let slots = stored;
	if (stored.key !== key) {
		slots = freshSlots(key, cache.current(), aiResults !== undefined);
		setSlots(slots);
	}
	// Même annonce, autre version (prix, description…) : l'ancien verdict IA
	// n'est plus affiché, sans un rendu avec lui.
	const fingerprint = listingFingerprint(view.listing);
	// La file d'« Analyser » ne vaut que pour la version de l'annonce affichée au clic.
	if (
		scopeRef.current.queued !== null &&
		scopeRef.current.queued !== fingerprint
	)
		scopeRef.current.queued = null;
	const fresh = dropStale(slots, fingerprint);
	if (fresh !== slots) {
		slots = fresh;
		// Appliqué à l'état le plus récent, qui peut différer de celui de ce rendu.
		setSlots((prev) => dropStale(prev, fingerprint));
	}

	// L'annonce et le rapport les plus récents, lus au moment du clic.
	const viewRef = useRef(view);
	viewRef.current = view;
	// L'état du dernier rendu, lu au moment du clic (analyse incluse ou non).
	const slotsRef = useRef(slots);
	slotsRef.current = slots;

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

	/**
	 * État de l'identification. Un `done` retient l'empreinte de l'annonce
	 * identifiée et `byUser` (« Identifier » de l'utilisateur) ; `onlyIfIdle` :
	 * pas d'écrasement d'une identification en cours ou finie.
	 */
	const setIdentification = useCallback(
		(
			scope: Scope,
			state: IdentifyState,
			identified?: string,
			byUser = false,
			onlyIfIdle = false,
		) =>
			patch(scope, (prev) =>
				onlyIfIdle && prev.identification.status !== "idle"
					? prev
					: {
							...prev,
							identification: state,
							identifiedFingerprint:
								state.status === "done" && identified !== undefined
									? identified
									: null,
							identifiedByUser: state.status === "done" && byUser,
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
			// Annonce changée depuis l'analyse ou l'identification : pilules au repos.
			if (!entry || entry.fingerprint !== current) return;
			// Identification et analyse reprises séparément. I1 : jamais le quota
			// restant de l'époque. Une requête en cours ou finie (pas `idle`)
			// l'emporte sur l'entrée lue. Aucun déroulé n'est gardé.
			if (entry.identification)
				setIdentification(
					scope,
					{
						status: "done",
						result: withoutRemaining(entry.identification),
						progress: null,
					},
					entry.fingerprint,
					entry.identifiedByUser,
					true,
				);
			// Résultat partiel (carte) : pastille « Analyser ».
			if (!entry.result || entry.result.partial) return;
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
		// Lecture finie, réussie ou non : la pastille peut proposer « Analyser ».
		const settled = (entry: StoredAiResult | null) => {
			adopt(entry);
			patch(scope, (prev) => ({ ...prev, restoring: false }));
		};
		void aiResults.get(site, externalId).then(settled, () => settled(null));
	}, [aiResults, key, setAi, setIdentification, patch]);

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

	/** La requête d'un clic : l'annonce et le rapport les plus récents. */
	const requestFor = useCallback((noCache: boolean): ScanRequest => {
		const { listing, report } = viewRef.current;
		return {
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
	}, []);

	/**
	 * Fin d'une requête, réussie ou non : session expirée (R8), l'accès en cache
	 * ne vaut plus, pour les icônes de cartes aussi ; puis l'accès est relu.
	 */
	const afterRequest = useCallback(
		(scope: Scope, state: ScanState | IdentifyState) => {
			if (state.status === "error" && RELOGIN_CODES.has(state.code))
				cache.invalidate();
			// Quota consommé, session expirée (R3 : l'accès relu dit alors signedOut) :
			// l'accès est relu après chaque requête, réussie ou non, même actif en cache.
			if (current(scope)) readAccess(scope);
		},
		[cache, current, readAccess],
	);

	/**
	 * Lance l'analyse (`noCache` : relance du superuser). `afterIdentify` : partie
	 * de la file à la fin d'une identification réussie de la même version de
	 * l'annonce, donc incluse, avant même le rendu qui l'affiche.
	 */
	const run = useCallback(
		(noCache: boolean, afterIdentify = false) => {
			const scope = scopeRef.current;
			if (!current(scope)) return;
			// « Analyser » pendant une identification : mis en file, sans requête,
			// pour la version de l'annonce affichée au clic.
			if (scope.identifying !== null) {
				if (noCache) return;
				const queuedFingerprint = listingFingerprint(viewRef.current.listing);
				scope.queued = queuedFingerprint;
				patch(scope, (prev) => ({ ...prev, queuedFingerprint }));
				return;
			}
			// Une analyse en cours (scan ou relance) : pas de seconde (double clic).
			if (scope.inflight) return;
			const request = requestFor(noCache);
			const { listing } = request;
			const analysed = listingFingerprint(listing);
			// « Analyser » affichait l'analyse incluse avec l'identification de l'utilisateur.
			const shown = slotsRef.current;
			const included =
				!noCache &&
				(afterIdentify ||
					(shown.identification.status === "done" &&
						shown.identifiedByUser &&
						shown.identifiedFingerprint === analysed &&
						shown.ai.status !== "done"));
			// Suivie ici, hors de l'état React : le résultat final la garde (déroulé
			// du panneau), y compris celui d'une relance.
			let progress = startProgress(Date.now());
			// Progression de l'identification faite par le pipeline de l'analyse : le
			// déroulé de la pilule « Identifier », à part de celui de l'analyse.
			let identifyProgress = startProgress(Date.now());
			// Phase d'identification du flux en cours : ses recherches et sa réflexion
			// vont au déroulé de l'identification.
			let identifyPhase = false;
			if (noCache) {
				// Relance : le résultat affiché reste en place (pas de retour à
				// « Analyser »), seul le bouton de la section Debug change.
				patch(scope, (prev) => ({
					...prev,
					rescanning: true,
					rescanError: null,
				}));
			} else setAi(scope, { status: "loading", progress });
			debugLog?.group("scan demandé", request);

			/**
			 * Identification `done` venue de l'analyse. Pour la même empreinte, une
			 * identification de l'utilisateur le reste.
			 */
			const identified = (result: IdentificationResult) => {
				const seen = identifyProgress.steps.length > 0;
				const followed = identifyProgress;
				patch(scope, (prev) => ({
					...prev,
					identification: {
						status: "done",
						result,
						progress: seen
							? followed
							: prev.identification.status === "done"
								? prev.identification.progress
								: null,
					},
					identifiedFingerprint: analysed,
					identifiedByUser:
						prev.identification.status === "done" &&
						prev.identifiedFingerprint === analysed &&
						prev.identifiedByUser,
				}));
			};
			/**
			 * État de l'identification pendant l'analyse, sauf si elle est déjà
			 * `done` pour l'annonce analysée (reprise, ou identifiée avant) : elle
			 * n'est pas remise en cours.
			 */
			const identifying = (state: IdentifyState) =>
				patch(scope, (prev) =>
					prev.identification.status === "done" &&
					prev.identifiedFingerprint === analysed
						? prev
						: {
								...prev,
								identification: state,
								identifiedFingerprint: null,
								identifiedByUser: false,
							},
				);
			/** L'identification encore en cours à la fin de l'analyse prend `state`. */
			const settleIdentifying = (state: IdentifyState) =>
				patch(scope, (prev) =>
					prev.identification.status === "loading"
						? { ...prev, identification: state }
						: prev,
				);
			// La pilule « Identifier » est en cours dès le clic, avec son propre
			// déroulé : l'identification est la première phase de l'analyse (une
			// identification servie du cache passe aussitôt à `done`).
			if (!noCache)
				identifying({ status: "loading", progress: identifyProgress });

			const onEvent = (e: ScanProgressEvent) => {
				// Événement d'une annonce quittée, ou après le démontage : ignoré.
				if (!current(scope)) return;
				const ends =
					e.type === "identification" || e.type === "identification_error";
				if (isIdentifyProgress(e)) identifyPhase = true;
				const ofIdentification =
					ends ||
					isIdentifyProgress(e) ||
					(identifyPhase && SHARED_EVENTS.has(e.type));
				if (ends) identifyPhase = false;
				if (ofIdentification) {
					// Relance sans cache : l'identification affichée n'est pas touchée.
					if (noCache) return;
					identifyProgress = addEvent(identifyProgress, e, Date.now());
					if (e.type === "identification") {
						const { type: _, ...result } = e;
						identified(result);
					} else if (e.type === "identification_error")
						identifying({ status: "error", code: e.code });
					else identifying({ status: "loading", progress: identifyProgress });
					return;
				}
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
				// l'entrée porte l'empreinte de l'annonce lue au clic. L'analyse ne
				// change pas `identifiedByUser` (le magasin le garde pour la même empreinte).
				if (state.status === "done")
					void aiResults
						?.put(listing.site, listing.externalId, {
							result: state.result,
							identification: state.result.identification ?? null,
							identifiedByUser: false,
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
				// L'identification du résultat devient celle affichée ; sans elle, une
				// identification restée en cours revient au repos (analyse réussie, ou
				// en échec avant tout événement de l'identification) ou prend l'erreur
				// de l'analyse.
				if (state.status === "done") {
					const embedded = state.result.identification;
					if (embedded) identified(embedded);
					else settleIdentifying(IDENTIFY_IDLE);
				} else if (state.status === "error")
					settleIdentifying(
						identifyProgress.steps.length > 0
							? { status: "error", code: state.code }
							: IDENTIFY_IDLE,
					);
				// Analyse incluse refusée faute de quota : l'identification ne la donne
				// plus (le serveur l'a dit), « Inclus » disparaît et un nouveau clic ne
				// boucle pas sur le même refus. Le magasin l'oublie aussi.
				if (
					included &&
					state.status === "error" &&
					state.code === "quota_exhausted"
				) {
					patch(scope, (prev) =>
						prev.identifiedFingerprint === analysed
							? { ...prev, identifiedByUser: false }
							: prev,
					);
					void aiResults
						?.forgetIdentifiedByUser(listing.site, listing.externalId, analysed)
						.catch(() => {});
				}
				afterRequest(scope, state);
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
		[
			client,
			current,
			patch,
			setAi,
			requestFor,
			afterRequest,
			aiResults,
			debugLog,
		],
	);

	const scan = useCallback(() => run(false), [run]);
	const rescan = useCallback(() => run(true), [run]);

	const identify = useCallback(() => {
		const scope = scopeRef.current;
		// Une identification ou une analyse en cours : pas de seconde (double clic).
		if (scope.inflight || !current(scope)) return;
		const request = requestFor(false);
		const { listing } = request;
		const identified = listingFingerprint(listing);
		let progress = startProgress(Date.now());
		setIdentification(scope, { status: "loading", progress });
		debugLog?.group("identification demandée", request);

		const onEvent = (e: ScanProgressEvent) => {
			if (!current(scope)) return;
			progress = addEvent(progress, e, Date.now());
			const loading: IdentifyState = { status: "loading", progress };
			patch(scope, (prev) =>
				prev.identification.status === "loading"
					? { ...prev, identification: loading }
					: prev,
			);
		};
		const finish = (state: IdentifyState) => {
			if (scope.inflight === handle) {
				scope.inflight = null;
				scope.identifying = null;
			}
			// Annulée (autre annonce, démontage) : la portée et sa file sont oubliées.
			if (state.status === "error" && state.code === CANCELLED) return;
			debugLog?.group("identification reçue", scanOutcome(state));
			if (state.status === "done")
				void aiResults
					?.put(listing.site, listing.externalId, {
						result: null,
						identification: state.result,
						identifiedByUser: true,
						fingerprint: identified,
						storedAt: Date.now(),
					})
					.catch(() => {});
			setIdentification(scope, state, identified, true);
			afterRequest(scope, state);
			// La file part, réussie ou non, si l'annonce affichée est celle du clic.
			const queued = scope.queued;
			scope.queued = null;
			patch(scope, (prev) => ({ ...prev, queuedFingerprint: null }));
			if (
				queued !== null &&
				current(scope) &&
				listingFingerprint(viewRef.current.listing) === queued
			)
				run(false, state.status === "done" && queued === identified);
		};

		const handle = client.identify(request, onEvent);
		scope.inflight = handle;
		scope.identifying = identified;
		void handle.done.then(
			(response) =>
				finish(
					response.ok
						? { status: "done", result: response.data, progress }
						: { status: "error", code: response.error.code },
				),
			() => finish({ status: "error", code: "background_unavailable" }),
		);
	}, [
		client,
		current,
		patch,
		setIdentification,
		requestFor,
		afterRequest,
		aiResults,
		debugLog,
		run,
	]);

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
		identification: slots.identification,
		identify,
		queued: slots.queuedFingerprint !== null,
		analysisIncluded:
			slots.identification.status === "done" &&
			slots.identifiedByUser &&
			slots.ai.status !== "done",
		loginUnavailable: slots.loginUnavailable,
		pricingUrl: `${PUBLIC_URL}/pricing/?lang=${locale}`,
		loadAccess,
		scan,
		rescan,
		rescanning: slots.rescanning,
		rescanError: slots.rescanError,
		restoring: slots.restoring,
		login,
	};
}
