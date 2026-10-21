import { useSession } from "../session";

export function AccessDenied() {
	const { signOut } = useSession();
	return (
		<main className="mx-auto max-w-sm space-y-4 p-6">
			<h1 className="text-xl font-semibold">
				Accès réservé aux administrateurs
			</h1>
			<button
				type="button"
				onClick={() => void signOut()}
				className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
			>
				Se déconnecter
			</button>
		</main>
	);
}
