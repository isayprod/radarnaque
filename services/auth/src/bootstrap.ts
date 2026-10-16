/**
 * Client de la route interne de l'API qui crée l'abonnement d'essai d'un nouvel utilisateur.
 * Lève une exception (statut non 2xx, réseau, délai dépassé) : l'appelant la journalise,
 * et `GET /api/me` rattrape l'essai manquant.
 */
export function makeBootstrapClient(
	apiUrl: string,
	secret: string,
	{ timeoutMs = 3_000 }: { timeoutMs?: number } = {},
): (userId: string) => Promise<void> {
	const base = apiUrl.replace(/\/+$/, "");
	return async (userId) => {
		const res = await fetch(
			`${base}/api/internal/users/${encodeURIComponent(userId)}/bootstrap`,
			{
				method: "POST",
				headers: { "x-internal-secret": secret },
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		await res.body?.cancel();
		if (!res.ok) {
			throw new Error(
				`bootstrap de l'utilisateur ${userId} : l'API a répondu ${res.status}`,
			);
		}
	};
}
