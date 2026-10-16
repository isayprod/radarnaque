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

	browser.runtime.onMessage.addListener(
		createMessageListener((message: BgRequest) => handle(message)),
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
