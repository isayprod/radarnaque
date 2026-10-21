import type { MouseEvent } from "react";
import { NotFound } from "./pages/NotFound";
import { hrefOf, type Route, useRoute } from "./router";

type NavItem = {
	label: string;
	route: Route;
	active: (route: Route) => boolean;
};

// Partie 1 : deux entrées. Les autres écrans arrivent avec la partie 2 (pas d'entrée morte).
const NAV: NavItem[] = [
	{
		label: "Utilisateurs",
		route: { name: "users" },
		active: (r) => r.name === "users" || r.name === "user",
	},
	{ label: "IA", route: { name: "ai" }, active: (r) => r.name === "ai" },
];

function title(route: Route): string {
	switch (route.name) {
		case "users":
			return "Utilisateurs";
		case "user":
			return "Fiche utilisateur";
		case "ai":
			return "IA";
		case "notFound":
			return "Page introuvable";
	}
}

function Content({ route }: { route: Route }) {
	switch (route.name) {
		case "notFound":
			return <NotFound />;
		default:
			return null;
	}
}

export function App() {
	const [route, navigate] = useRoute();

	// Clic simple : navigation interne ; Ctrl, Cmd, Maj ou clic milieu gardent le
	// comportement du navigateur (nouvel onglet).
	const onNavigate = (event: MouseEvent<HTMLAnchorElement>, target: Route) => {
		if (
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		) {
			return;
		}
		event.preventDefault();
		navigate(target);
	};

	return (
		<div className="flex min-h-screen">
			<nav
				aria-label="Navigation"
				className="w-56 shrink-0 border-r border-slate-200 bg-slate-50 p-4"
			>
				<p className="mb-6 text-sm font-semibold text-brand-700">Radarnaque</p>
				<ul className="space-y-1">
					{NAV.map((item) => {
						const active = item.active(route);
						return (
							<li key={item.label}>
								<a
									href={hrefOf(item.route)}
									aria-current={active ? "page" : undefined}
									onClick={(event) => onNavigate(event, item.route)}
									className={`block rounded-md px-3 py-2 text-sm ${
										active
											? "bg-brand-50 font-medium text-brand-700"
											: "text-slate-700 hover:bg-slate-100"
									}`}
								>
									{item.label}
								</a>
							</li>
						);
					})}
				</ul>
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="border-b border-slate-200 px-6 py-4">
					<h1 className="text-xl font-semibold">{title(route)}</h1>
				</header>
				<main className="flex-1 p-6">
					<Content route={route} />
				</main>
			</div>
		</div>
	);
}
