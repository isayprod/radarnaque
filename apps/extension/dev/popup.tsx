/**
 * Galerie de la popup (`pnpm --filter extension gallery`, puis
 * `http://localhost:3101/popup.html?state=…&lang=…`).
 *
 * Rend le vrai `App` de la popup, avec ses styles. `vite.gallery.config.ts` remplace
 * `lib/messages`, `lib/storage` et `wxt/browser` par les doublures de `doubles/` :
 * les réponses du service worker suivent le scénario de l'adresse (`scenario.ts`).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../entrypoints/popup/App";
import { t } from "../lib/i18n";
import "../entrypoints/popup/style.css";
import { SCENARIO } from "./doubles/scenario";

document.documentElement.lang = SCENARIO.lang;

const root = document.getElementById("root");
if (!root) throw new Error("#root introuvable");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

/** Écrit dans un champ contrôlé par React (setter natif, puis `input`). */
function typeInto(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(input, text);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Suppression dépliée (et mot tapé) dès que l'écran du compte est rendu.
if (SCENARIO.deletion !== "closed") {
	const observer = new MutationObserver(() => {
		const details = root.querySelector("details");
		if (!details) return;
		observer.disconnect();
		details.open = true;
		const input = details.querySelector<HTMLInputElement>("#delete-confirm");
		if (SCENARIO.deletion === "typed" && input)
			typeInto(input, t(SCENARIO.lang, "delete.word"));
	});
	observer.observe(root, { childList: true, subtree: true });
}
