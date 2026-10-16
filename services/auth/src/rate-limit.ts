export interface RateLimiter {
	/** Enregistre une tentative pour `key`. Renvoie `false` (sans l'enregistrer) si la limite est atteinte. */
	hit(key: string): boolean;
}

/**
 * Limiteur en mémoire à fenêtre glissante : au plus `max` tentatives par clé sur `windowMs`.
 * Propre au processus (un seul conteneur auth) ; les clés expirées sont purgées au fil de l'eau.
 */
export function createRateLimiter({
	max,
	windowMs,
	now = Date.now,
}: {
	max: number;
	windowMs: number;
	now?: () => number;
}): RateLimiter {
	const hits = new Map<string, number[]>();
	let lastSweep = now();

	function sweep(t: number) {
		if (t - lastSweep < windowMs) return;
		lastSweep = t;
		for (const [key, times] of hits) {
			if ((times.at(-1) ?? 0) <= t - windowMs) hits.delete(key);
		}
	}

	return {
		hit(key) {
			const t = now();
			sweep(t);
			const recent = (hits.get(key) ?? []).filter(
				(time) => time > t - windowMs,
			);
			if (recent.length >= max) {
				hits.set(key, recent);
				return false;
			}
			recent.push(t);
			hits.set(key, recent);
			return true;
		},
	};
}
