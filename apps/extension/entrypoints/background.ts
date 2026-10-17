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
} from "../lib/background-handlers";
import { PUBLIC_URL } from "../lib/config";
import { createJwtProvider } from "../lib/jwt-provider";
import type { BgRequest } from "../lib/messages";
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
	const handle = createHandlers({
		sessionToken,
		auth: { startSignIn, verifyOtp, signOutRemote },
		jwt,
		api,
		openPopup: () => browser.action.openPopup(),
	});

	// Messages internes : tout depuis les pages de l'extension (popup) ; depuis un
	// content script, uniquement la liste blanche, et seulement sur un site pris en charge.
	const handleInternal = guardSender(
		handle,
		{ id: browser.runtime.id, baseUrl: browser.runtime.getURL("/") },
		(url) => adapterFor(url) !== null,
	);
	browser.runtime.onMessage.addListener(
		createMessageListener(
			(message: BgRequest, sender: Browser.runtime.MessageSender) =>
				handleInternal(message, sender),
		),
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
