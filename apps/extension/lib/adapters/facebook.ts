import type { Site } from "../listing/types";
import type { MarketplaceAdapter } from "./types";

const SITES: Site[] = ["facebook.com"];

// Stub : la tâche 6 remplace les méthodes autres que id, sites et siteOf.
export const facebookAdapter: MarketplaceAdapter = {
	id: "facebook",
	sites: SITES,
	siteOf(url) {
		const { hostname } = url;
		return SITES.find((d) => hostname === d || hostname === `www.${d}`) ?? null;
	},
	pageType() {
		throw new Error("not implemented");
	},
	extractListing() {
		throw new Error("not implemented");
	},
	listingRoot() {
		throw new Error("not implemented");
	},
	badgeAnchor() {
		throw new Error("not implemented");
	},
};
