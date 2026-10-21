import type { components } from "@radarnaque/shared";
import { useEffect, useState } from "react";
import { useSession } from "./session";

type AdminOffer = components["schemas"]["AdminOfferOut"];

/** Codes des plans, dans l'ordre de l'offre (GET /api/admin/offer) ; `null` pendant le
 * chargement, et si l'offre n'a pas pu être lue. */
export function usePlans(): string[] | null {
	const session = useSession();
	const api = session.status === "ready" ? session.api : null;
	const [plans, setPlans] = useState<string[] | null>(null);

	useEffect(() => {
		if (api === null) return;
		let stale = false;
		api
			.get<AdminOffer>("/api/admin/offer")
			.then((offer) => {
				if (!stale) setPlans(offer.plans.map((plan) => plan.code));
			})
			.catch(() => {
				if (!stale) setPlans(null);
			});
		return () => {
			stale = true;
		};
	}, [api]);

	return plans;
}
