import type { Locale } from "@radarnaque/shared";
import { Component, type ReactNode } from "react";
import { aiErrorText } from "../lib/content-i18n";

interface Props {
	locale: Locale;
	children: ReactNode;
}

/**
 * Isole la section IA : une erreur de rendu n'y emporte pas la pastille, dont
 * le score local et les signaux restent lisibles ; la section affiche alors
 * `ai.error.default`. Une nouvelle annonce (autre `key`) retente le rendu.
 */
export class AiErrorBoundary extends Component<Props, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override componentDidCatch(error: unknown) {
		console.debug(`radarnaque: section IA indisponible (${String(error)})`);
	}

	override render() {
		if (!this.state.failed) return this.props.children;
		return (
			<p className="m-0 mt-3 border-t border-slate-200 pt-2 text-red-700">
				{aiErrorText(this.props.locale, "default")}
			</p>
		);
	}
}
