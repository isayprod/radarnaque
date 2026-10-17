import { facebookAdapter } from "./facebook";
import { twhAdapter } from "./twh";
import type { MarketplaceAdapter } from "./types";

const ADAPTERS: MarketplaceAdapter[] = [twhAdapter, facebookAdapter];

/** Chaque adaptateur décide par nom d'hôte exact (ou `www.` + hôte), jamais par sous-chaîne. */
export function adapterFor(url: URL): MarketplaceAdapter | null {
	return ADAPTERS.find((adapter) => adapter.siteOf(url) !== null) ?? null;
}
