import "./pages.css";
import { detectLocale } from "./i18n";
import { renderPricing } from "./pages-render";

const root = document.getElementById("app");
if (root) {
	renderPricing(
		document,
		root,
		detectLocale(location.search, navigator.language),
	);
}
