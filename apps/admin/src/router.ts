import { useCallback, useSyncExternalStore } from "react";

export type Route =
	| { name: "dashboard" }
	| { name: "users" }
	| { name: "user"; id: string }
	| { name: "offer" }
	| { name: "ai"; promptId?: number }
	| { name: "analyses" }
	| { name: "analysis"; id: number }
	| { name: "notFound" };

const BASE = "/admin";

// Un identifiant numérique de l'URL : entier strictement positif, écrit en chiffres.
function numericId(text: string): number | null {
	if (!/^\d+$/.test(text)) return null;
	const id = Number(text);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// "/admin/" et "/admin" sont le tableau de bord. Un identifiant mal encodé (%zz) ou
// numérique invalide n'est pas une page : notFound.
export function parseRoute(pathname: string): Route {
	const notFound: Route = { name: "notFound" };
	if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return notFound;
	const parts = pathname.slice(BASE.length).split("/").filter(Boolean);
	if (parts.length === 0) return { name: "dashboard" };
	const [head, ...rest] = parts;
	switch (head) {
		case "utilisateurs": {
			if (rest.length === 0) return { name: "users" };
			if (rest.length > 1) return notFound;
			try {
				return { name: "user", id: decodeURIComponent(rest[0]) };
			} catch {
				return notFound;
			}
		}
		case "offre":
			return rest.length === 0 ? { name: "offer" } : notFound;
		case "ia": {
			if (rest.length === 0) return { name: "ai" };
			const promptId =
				rest.length === 2 && rest[0] === "prompts" ? numericId(rest[1]) : null;
			return promptId === null ? notFound : { name: "ai", promptId };
		}
		case "analyses": {
			if (rest.length === 0) return { name: "analyses" };
			const id = rest.length === 1 ? numericId(rest[0]) : null;
			return id === null ? notFound : { name: "analysis", id };
		}
		default:
			return notFound;
	}
}

export function hrefOf(route: Route): string {
	switch (route.name) {
		case "dashboard":
			return `${BASE}/`;
		case "users":
			return `${BASE}/utilisateurs`;
		case "user":
			return `${BASE}/utilisateurs/${encodeURIComponent(route.id)}`;
		case "offer":
			return `${BASE}/offre`;
		case "ai":
			return route.promptId === undefined
				? `${BASE}/ia`
				: `${BASE}/ia/prompts/${route.promptId}`;
		case "analyses":
			return `${BASE}/analyses`;
		case "analysis":
			return `${BASE}/analyses/${route.id}`;
		case "notFound":
			return `${BASE}/`;
	}
}

/** Clic simple : navigation interne ; Ctrl, Cmd, Maj, Alt ou clic milieu gardent le
 * comportement du navigateur (nouvel onglet). */
export function isPlainLeftClick(event: {
	button: number;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}): boolean {
	return (
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey
	);
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	window.addEventListener("popstate", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("popstate", listener);
	};
}

function currentPath(): string {
	return window.location.pathname;
}

export function useRoute(): [Route, (route: Route) => void] {
	const pathname = useSyncExternalStore(subscribe, currentPath);
	const navigate = useCallback((route: Route) => {
		const href = hrefOf(route);
		const { pathname: path, search, hash } = window.location;
		// Déjà sur cette URL : pas de nouvelle entrée d'historique (le retour arrière
		// ne doit pas rester sur la même page).
		if (`${path}${search}${hash}` === href) return;
		window.history.pushState(null, "", href);
		for (const listener of listeners) listener();
	}, []);
	return [parseRoute(pathname), navigate];
}
