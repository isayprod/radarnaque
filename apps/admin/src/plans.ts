import type { components } from "@radarnaque/shared";
import { useEffect, useState } from "react";
import { useSession } from "./session";

type AdminOffer = components["schemas"]["AdminOfferOut"];

/** Codes des plans, dans l'ordre de l'offre (GET /api/admin/offer), et l'échec de leur lecture :
 * `plans` est `null` pendant le chargement et après un échec (`failed`). */
export function usePlansState(): { plans: string[] | null; failed: boolean } {
	const session = useSession();
	const api = session.status === "ready" ? session.api : null;
	const [state, setState] = useState<{
		plans: string[] | null;
		failed: boolean;
	}>({ plans: null, failed: false });

	useEffect(() => {
		if (api === null) return;
		let stale = false;
		api
			.get<AdminOffer>("/api/admin/offer")
			.then((offer) => {
				if (!stale)
					setState({
						plans: offer.plans.map((plan) => plan.code),
						failed: false,
					});
			})
			.catch(() => {
				if (!stale) setState({ plans: null, failed: true });
			});
		return () => {
			stale = true;
		};
	}, [api]);

	return state;
}

/** Codes des plans ; `null` pendant le chargement, et si l'offre n'a pas pu être lue. */
export function usePlans(): string[] | null {
	return usePlansState().plans;
}
