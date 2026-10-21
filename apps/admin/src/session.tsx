import type { Me } from "@radarnaque/shared";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type AdminApi, createApi } from "./api";
import { fetchToken, signOut as signOutRemote } from "./auth";

export type SessionState =
	| { status: "loading" }
	| { status: "signedOut"; linkError: boolean }
	| { status: "denied"; email: string | null }
	| { status: "ready"; email: string; api: AdminApi };

type Session = SessionState & {
	signOut: () => Promise<void>;
	/** Vrai quand une session est établie (prête ou refusée), faux si on retombe sur la connexion. */
	refresh: () => Promise<boolean>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<SessionState>({ status: "loading" });
	const mounted = useRef(true);

	const update = useCallback(
		(next: SessionState | ((s: SessionState) => SessionState)) => {
			if (mounted.current) setState(next);
		},
		[],
	);

	// Démarrage : jeton, puis rôle. Aucun appel /api/admin/* avant `ready`.
	const refresh = useCallback(async (): Promise<boolean> => {
		const signedOut = () => update({ status: "signedOut", linkError: false });
		try {
			const first = await fetchToken();
			if (first === null) {
				const linkError =
					new URLSearchParams(window.location.search).get("erreur") === "lien";
				update({ status: "signedOut", linkError });
				return false;
			}
			// Le jeton déjà obtenu sert à la première requête, sans second appel.
			let pending: string | null = first;
			const api = createApi({
				fetchToken: async () => {
					const token = pending ?? (await fetchToken());
					pending = null;
					return token;
				},
				onSignedOut: signedOut,
				// Admin rétrogradé ou supprimé : écran refusé, pas de nouvelle tentative.
				onForbidden: () =>
					update((s) => ({
						status: "denied",
						email: s.status === "ready" ? s.email : null,
					})),
			});
			const me = await api.get<Me>("/api/me");
			update(
				me.role === "admin" || me.role === "superuser"
					? { status: "ready", email: me.email, api }
					: { status: "denied", email: me.email },
			);
			return true;
		} catch {
			// 401 déjà traité par onSignedOut ; toute autre panne ramène à la connexion.
			signedOut();
			return false;
		}
	}, [update]);

	const signOut = useCallback(async () => {
		try {
			await signOutRemote();
		} catch {
			// Hors ligne : on quitte quand même l'écran ; la session expirera côté serveur.
		}
		update({ status: "signedOut", linkError: false });
	}, [update]);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		return () => {
			mounted.current = false;
		};
	}, [refresh]);

	const value = useMemo(
		() => ({ ...state, signOut, refresh }),
		[state, signOut, refresh],
	);
	return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): Session {
	const session = useContext(SessionContext);
	if (!session) throw new Error("useSession hors de SessionProvider");
	return session;
}
