import "./pages.css";
import { detectLocale } from "./i18n";
import { fetchOffer } from "./offer";
import { renderPricing } from "./pages-render";

const root = document.getElementById("app");
if (root) {
	const locale = detectLocale(location.search, navigator.language);
	// Valeurs de secours tout de suite, puis l'offre en cours si l'API répond.
	renderPricing(document, root, locale);
	void fetchOffer().then((offer) => {
		if (offer) renderPricing(document, root, locale, offer);
	});
}
