import "./callback.css";
import { deliverSession } from "./deliver-session";
import { toDom } from "./h";
import { MESSAGES, type PageState, pickLocale } from "./i18n";
import { logoNode } from "./logo-node";

interface ChromeRuntime {
	sendMessage: (
		extensionId: string,
		message: unknown,
		callback: (response: unknown) => void,
	) => void;
	lastError?: unknown;
}

declare const chrome: { runtime?: ChromeRuntime } | undefined;

const locale = pickLocale(navigator.language);
const status = document.getElementById("status");
const logo = document.querySelector("[data-logo]");

function render(state: PageState): void {
	document.documentElement.lang = locale;
	if (status) status.textContent = MESSAGES[state][locale];
	// Logo animé pendant l'attente (indicateur de chargement), immobile ensuite.
	logo?.replaceChildren(
		toDom(document, logoNode({ size: 40, animated: state === "pending" })),
	);
}

async function fetchToken(): Promise<string | null> {
	const res = await fetch("/auth/extension/session-token", {
		credentials: "same-origin",
	});
	if (res.status !== 200) return null;
	const body = (await res.json()) as { token?: unknown };
	return typeof body.token === "string" && body.token ? body.token : null;
}

function sendToExtension(token: string): Promise<boolean> {
	const extensionId = import.meta.env.VITE_EXTENSION_ID;
	const runtime = typeof chrome === "undefined" ? undefined : chrome.runtime;
	if (!extensionId || !runtime?.sendMessage) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		try {
			runtime.sendMessage(
				extensionId,
				{ type: "radarnaque/session", token },
				(response) => {
					// Reading lastError marks it as handled (unknown extension id, etc.).
					void runtime.lastError;
					resolve(
						typeof response === "object" &&
							response !== null &&
							(response as { ok?: unknown }).ok === true,
					);
				},
			);
		} catch {
			resolve(false);
		}
	});
}

render("pending");
deliverSession({ fetchToken, sendToExtension }).then(render, () =>
	render("no-extension"),
);
