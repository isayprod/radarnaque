/** Un plan tel que `GET /api/offer` le décrit (prix `null` pour l'essai ou quand il manque). */
export interface OfferPlan {
	scans: number;
	maxImages: number;
	cardIcons: boolean;
	monthlyCents: number | null;
	yearlyCents: number | null;
}

export type Offer = {
	trial: OfferPlan;
	standard: OfferPlan;
	premium: OfferPlan;
};

const isCount = (v: unknown): v is number =>
	Number.isInteger(v) && (v as number) >= 0;

const isCountOrNull = (v: unknown): v is number | null =>
	v === null || isCount(v);

function parsePlan(raw: unknown): OfferPlan | null {
	if (!raw || typeof raw !== "object") return null;
	const p = raw as Record<string, unknown>;
	if (
		!isCount(p.scans) ||
		!isCount(p.maxImages) ||
		typeof p.cardIcons !== "boolean" ||
		!isCountOrNull(p.monthlyCents) ||
		!isCountOrNull(p.yearlyCents)
	) {
		return null;
	}
	return {
		scans: p.scans,
		maxImages: p.maxImages,
		cardIcons: p.cardIcons,
		monthlyCents: p.monthlyCents,
		yearlyCents: p.yearlyCents,
	};
}

/** Valide le corps de `GET /api/offer` ; `null` si la forme ne correspond pas. */
export function parseOffer(body: unknown): Offer | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	const trial = parsePlan(b.trial);
	const standard = parsePlan(b.standard);
	const premium = parsePlan(b.premium);
	return trial && standard && premium ? { trial, standard, premium } : null;
}

/** Lit l'offre en cours ; `null` sur erreur réseau, statut ≠ 200 ou forme inattendue. */
export async function fetchOffer(
	fetchImpl: typeof fetch = fetch,
): Promise<Offer | null> {
	try {
		const res = await fetchImpl("/api/offer");
		if (res.status !== 200) return null;
		return parseOffer(await res.json());
	} catch {
		return null;
	}
}
