import { Link } from "./components/Link";
import { secondaryButton } from "./components/ui";
import { AccessDenied } from "./pages/AccessDenied";
import { Ai } from "./pages/Ai";
import { Analyses } from "./pages/Analyses";
import { AnalysisCard } from "./pages/AnalysisCard";
import { Dashboard } from "./pages/Dashboard";
import { NotFound } from "./pages/NotFound";
import { Offer } from "./pages/Offer";
import { SignIn } from "./pages/SignIn";
import { UserCard } from "./pages/UserCard";
import { Users } from "./pages/Users";
import { type Route, useRoute } from "./router";
import { useSession } from "./session";

type NavItem = {
	label: string;
	route: Route;
	active: (route: Route) => boolean;
};

const NAV: NavItem[] = [
	{
		label: "Tableau de bord",
		route: { name: "dashboard" },
		active: (r) => r.name === "dashboard",
	},
	{
		label: "Utilisateurs",
		route: { name: "users" },
		active: (r) => r.name === "users" || r.name === "user",
	},
	{
		label: "Offre",
		route: { name: "offer" },
		active: (r) => r.name === "offer",
	},
	{ label: "IA", route: { name: "ai" }, active: (r) => r.name === "ai" },
	{
		label: "Analyses",
		route: { name: "analyses" },
		active: (r) => r.name === "analyses" || r.name === "analysis",
	},
];

function title(route: Route): string {
	switch (route.name) {
		case "dashboard":
			return "Tableau de bord";
		case "users":
			return "Utilisateurs";
		case "user":
			return "Fiche utilisateur";
		case "offer":
			return "Offre";
		case "ai":
			return "IA";
		case "analyses":
			return "Analyses";
		case "analysis":
			return "Analyse";
		case "notFound":
			return "Page introuvable";
	}
}

function Content({ route }: { route: Route }) {
	switch (route.name) {
		case "dashboard":
			return <Dashboard />;
		case "users":
			return <Users />;
		case "user":
			return <UserCard id={route.id} />;
		case "offer":
			return <Offer />;
		case "ai":
			return <Ai promptId={route.promptId} />;
		case "analyses":
			return <Analyses />;
		case "analysis":
			return <AnalysisCard id={route.id} />;
		case "notFound":
			return <NotFound />;
	}
}

export function App() {
	const session = useSession();
	switch (session.status) {
		case "loading":
			return <p className="p-6 text-sm text-slate-500">Chargement…</p>;
		case "signedOut":
			return <SignIn linkError={session.linkError} />;
		case "denied":
			return <AccessDenied />;
		case "ready":
			return <Shell email={session.email} onSignOut={session.signOut} />;
	}
}

function Shell({
	email,
	onSignOut,
}: {
	email: string;
	onSignOut: () => Promise<void>;
}) {
	const [route] = useRoute();

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
								<Link
									route={item.route}
									aria-current={active ? "page" : undefined}
									className={`block rounded-md px-3 py-2 text-sm ${
										active
											? "bg-brand-50 font-medium text-brand-700"
											: "text-slate-700 hover:bg-slate-100"
									}`}
								>
									{item.label}
								</Link>
							</li>
						);
					})}
				</ul>
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
					<h1 className="text-xl font-semibold">{title(route)}</h1>
					<div className="flex items-center gap-3 text-sm">
						<span className="break-all text-slate-600">{email}</span>
						<button
							type="button"
							onClick={() => void onSignOut()}
							className={secondaryButton}
						>
							Se déconnecter
						</button>
					</div>
				</header>
				<main className="flex-1 p-6">
					<Content route={route} />
				</main>
			</div>
		</div>
	);
}
