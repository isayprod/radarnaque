import { useCallback, useSyncExternalStore } from "react";

export type Route =
	| { name: "users" }
	| { name: "user"; id: string }
	| { name: "ai" }
	| { name: "notFound" };

const BASE = "/admin";

// "/admin/", "/admin" et "/admin/utilisateurs" sont la même page. Un identifiant mal
// encodé (%zz) n'est pas une fiche : notFound.
export function parseRoute(pathname: string): Route {
	if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) {
		return { name: "notFound" };
	}
	const parts = pathname.slice(BASE.length).split("/").filter(Boolean);
	if (parts.length === 0) return { name: "users" };
	const [head, id, ...rest] = parts;
	if (head === "utilisateurs" && id === undefined) return { name: "users" };
	if (head === "utilisateurs" && rest.length === 0) {
		try {
			return { name: "user", id: decodeURIComponent(id) };
		} catch {
			return { name: "notFound" };
		}
	}
	if (head === "ia" && id === undefined) return { name: "ai" };
	return { name: "notFound" };
}

export function hrefOf(route: Route): string {
	switch (route.name) {
		case "users":
			return `${BASE}/utilisateurs`;
		case "user":
			return `${BASE}/utilisateurs/${encodeURIComponent(route.id)}`;
		case "ai":
			return `${BASE}/ia`;
		case "notFound":
			return `${BASE}/`;
	}
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
		window.history.pushState(null, "", hrefOf(route));
		for (const listener of listeners) listener();
	}, []);
	return [parseRoute(pathname), navigate];
}
