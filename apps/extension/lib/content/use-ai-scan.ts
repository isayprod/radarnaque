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
}

const IDLE: ScanState = { status: "idle" };

const freshSlots = (key: string, access: AccessState | null): Slots => ({
	key,
	access,
	text: IDLE,
	image: IDLE,
	loginUnavailable: false,
});

const freshScope = (key: string): Scope => ({
	key,
	inflight: new Set(),
	reading: false,
	accessSeq: 0,
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
 */
export function useAiScan(
	client: AiClient,
	view: BadgeView,
	locale: Locale,
	accessCache?: AccessCache,
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
			patch(scope, { [kind]: { status: "loading" } });
			const finish = (state: ScanState) => {
				scope.inflight.delete(kind);
				patch(scope, { [kind]: state });
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
		[client, patch, readAccess, cache],
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
