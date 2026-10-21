import type { components } from "@radarnaque/shared";
import { useEffect, useRef, useState } from "react";
import type { AdminApi } from "../api";
import { formatDateTime } from "../format";
import { hrefOf, isPlainLeftClick, useRoute } from "../router";
import { useSession } from "../session";

type UserList = components["schemas"]["AdminUserListOut"];

const SEARCH_MIN = 3;
const SEARCH_DELAY_MS = 300;

const field =
	"rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand-600";

export function Users() {
	const session = useSession();
	return session.status === "ready" ? <UserList api={session.api} /> : null;
}

function listPath(
	filters: { q: string | null; role: string; plan: string },
	before: string | null,
): string {
	const params = new URLSearchParams();
	if (filters.q !== null) params.set("q", filters.q);
	if (filters.role) params.set("role", filters.role);
	if (filters.plan) params.set("plan", filters.plan);
	if (before !== null) params.set("before", before);
	const query = params.toString();
	return `/api/admin/users${query ? `?${query}` : ""}`;
}

function UserList({ api }: { api: AdminApi }) {
	const [, navigate] = useRoute();
	const [input, setInput] = useState("");
	// Terme réellement envoyé : au moins 3 caractères, 300 ms après la dernière frappe.
	const [q, setQ] = useState<string | null>(null);
	const [role, setRole] = useState("");
	const [plan, setPlan] = useState("");
	const [items, setItems] = useState<UserList["items"]>([]);
	const [nextBefore, setNextBefore] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	// Change à chaque nouvelle recherche : une page suivante de l'ancienne est ignorée.
	const generation = useRef(0);

	useEffect(() => {
		const term = input.trim();
		const next = term.length >= SEARCH_MIN ? term : null;
		const timer = setTimeout(() => setQ(next), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [input]);

	useEffect(() => {
		let stale = false;
		generation.current += 1;
		setLoading(true);
		setError(false);
		api
			.get<UserList>(listPath({ q, role, plan }, null))
			.then((page) => {
				if (stale) return;
				setItems(page.items);
				setNextBefore(page.nextBefore);
			})
			.catch(() => {
				if (stale) return;
				// Les anciens résultats ne correspondent plus aux filtres, et leur curseur
				// ne doit pas servir avec les nouveaux.
				setItems([]);
				setNextBefore(null);
				setError(true);
			})
			.finally(() => {
				if (!stale) setLoading(false);
			});
		return () => {
			stale = true;
		};
	}, [api, q, role, plan]);

	async function loadMore() {
		if (nextBefore === null || loading) return;
		const mine = generation.current;
		setLoading(true);
		setError(false);
		try {
			const page = await api.get<UserList>(
				listPath({ q, role, plan }, nextBefore),
			);
			if (mine !== generation.current) return;
			setItems((current) => [...current, ...page.items]);
			setNextBefore(page.nextBefore);
		} catch {
			if (mine === generation.current) setError(true);
		} finally {
			if (mine === generation.current) setLoading(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-4">
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="user-search">
						Rechercher par email
					</label>
					<input
						id="user-search"
						type="search"
						autoComplete="off"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						className={`${field} block w-72`}
					/>
					<p className="text-xs text-slate-500">3 caractères au moins.</p>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="user-role">
						Rôle
					</label>
					<select
						id="user-role"
						value={role}
						onChange={(event) => setRole(event.target.value)}
						className={`${field} block`}
					>
						<option value="">Tous</option>
						<option value="user">user</option>
						<option value="admin">admin</option>
						<option value="superuser">superuser</option>
					</select>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="user-plan">
						Plan
					</label>
					<select
						id="user-plan"
						value={plan}
						onChange={(event) => setPlan(event.target.value)}
						className={`${field} block`}
					>
						<option value="">Tous</option>
						<option value="trial">trial</option>
						<option value="standard">standard</option>
						<option value="premium">premium</option>
						<option value="none">Aucun</option>
					</select>
				</div>
			</div>

			<div aria-live="polite" className="min-h-5 text-sm">
				{error && (
					<p className="text-red-700">Impossible de charger la liste.</p>
				)}
				{loading && <p className="text-slate-500">Chargement…</p>}
			</div>

			{items.length === 0 && !loading && !error ? (
				<p className="text-sm text-slate-500">Aucun compte.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-xs text-slate-500">
							<tr>
								<th className="py-2 pr-4 font-medium">Email</th>
								<th className="py-2 pr-4 font-medium">Rôle</th>
								<th className="py-2 pr-4 font-medium">Plan</th>
								<th className="py-2 pr-4 font-medium">Utilisées</th>
								<th className="py-2 pr-4 font-medium">Restantes</th>
								<th className="py-2 pr-4 font-medium">Créé le</th>
								<th className="py-2 font-medium">Dernière analyse</th>
							</tr>
						</thead>
						<tbody>
							{items.map((item) => {
								const target = { name: "user", id: item.id } as const;
								return (
									<tr key={item.id} className="border-t border-slate-100">
										<td className="py-2 pr-4 break-all">
											<a
												href={hrefOf(target)}
												onClick={(event) => {
													if (!isPlainLeftClick(event)) return;
													event.preventDefault();
													navigate(target);
												}}
												className="font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
											>
												{item.email}
											</a>
										</td>
										<td className="py-2 pr-4">{item.role}</td>
										<td className="py-2 pr-4">{item.plan ?? "aucun"}</td>
										<td className="py-2 pr-4">{item.used ?? "—"}</td>
										<td className="py-2 pr-4">{item.remaining ?? "—"}</td>
										<td className="py-2 pr-4 whitespace-nowrap">
											{formatDateTime(item.createdAt)}
										</td>
										<td className="py-2 whitespace-nowrap">
											{formatDateTime(item.lastScanAt)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{nextBefore !== null && (
				<button
					type="button"
					onClick={() => void loadMore()}
					disabled={loading}
					className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
				>
					Page suivante
				</button>
			)}
		</div>
	);
}
