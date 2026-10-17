import type { Site } from "../listing/types";
import type { MarketplaceAdapter } from "./types";

const SITES: Site[] = ["2ememain.be", "2dehands.be"];

// Stub : la tâche 5 remplace les méthodes autres que id, sites et siteOf.
export const twhAdapter: MarketplaceAdapter = {
	id: "twh",
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
