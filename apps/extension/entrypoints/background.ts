import { type Browser, browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
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
	guardInternalSender,
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
	});

	// Messages internes : uniquement depuis les pages de l'extension (popup), jamais
	// depuis un script de contenu ou un onglet.
	const handleInternal = guardInternalSender(handle, {
		id: browser.runtime.id,
		baseUrl: browser.runtime.getURL("/"),
	});
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
