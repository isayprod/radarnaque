import { type Browser, browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { adapterFor } from "../lib/adapters/registry";
import { createApiClient } from "../lib/api-client";
import {
	fetchJwt,
	signOutRemote,
	startSignIn,
	verifyOtp,
} from "../lib/auth-client";
import {
	createHandlers,
	createMessageListener,
	guardSender,
	handleExternal,
	portSenderGuard,
} from "../lib/background-handlers";
import { PUBLIC_URL } from "../lib/config";
import { clearAiResults } from "../lib/content/ai-results";
import { createDebugState } from "../lib/debug-state";
import { createJwtProvider } from "../lib/jwt-provider";
import type { BgRequest } from "../lib/messages";
import { createScanPortListener } from "../lib/scan-port";
import { sessionToken } from "../lib/storage";

export default defineBackground(() => {
	const jwt = createJwtProvider({
		getSessionToken: () => sessionToken.getValue(),
		fetchJwt,
	});
	const api = createApiClient({
		jwt,
		fetch: (input, init) => fetch(input, init),
		onUnauthenticated: async () => {
			await sessionToken.setValue(null);
			jwt.invalidate();
		},
	});
	// R5 : plomberie du superuser (content/debug, lecture paresseuse de me) en dev seulement.
	const devBuild = import.meta.env.DEV;
	// Un seul état du debug (R3) pour les messages et le port `scan/stream`.
	const debug = createDebugState({
		sessionToken,
		getMe: () => api.getMe(),
		devBuild,
	});
	const handle = createHandlers({
		sessionToken,
		auth: { startSignIn, verifyOtp, signOutRemote },
		jwt,
		api,
		openPopup: () => browser.action.openPopup(),
		clearAiResults,
		devBuild,
		debug,
	});

	const self = { id: browser.runtime.id, baseUrl: browser.runtime.getURL("/") };
	const isSupportedPage = (url: URL) => adapterFor(url) !== null;
	// Messages internes : tout depuis les pages de l'extension (popup) ; depuis un
	// content script, uniquement la liste blanche, et seulement sur un site pris en charge.
	const handleInternal = guardSender(handle, self, isSupportedPage);
	browser.runtime.onMessage.addListener(
		createMessageListener(
			(message: BgRequest, sender: Browser.runtime.MessageSender) =>
				handleInternal(message, sender),
		),
	);
	// Analyse en flux : le port `scan/stream`, avec le même contrôle de l'émetteur.
	browser.runtime.onConnect.addListener(
		createScanPortListener({
			api,
			allowSender: portSenderGuard(self, isSupportedPage),
			debug,
		}),
	);
	browser.runtime.onMessageExternal.addListener(
		createMessageListener(
			(message: unknown, sender: Browser.runtime.MessageSender) =>
				handleExternal(message, sender, {
					publicUrl: PUBLIC_URL,
					sessionToken,
					jwt,
				}),
		),
	);
});
