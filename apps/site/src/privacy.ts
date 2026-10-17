import "./pages.css";
import { detectLocale } from "./i18n";
import { renderPrivacy } from "./pages-render";

const root = document.getElementById("app");
if (root) {
	renderPrivacy(
		document,
		root,
		detectLocale(location.search, navigator.language),
	);
}
