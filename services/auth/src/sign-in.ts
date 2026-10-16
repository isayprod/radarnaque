import { AsyncLocalStorage } from "node:async_hooks";
import type { Locale } from "@radarnaque/shared";
import type { Auth } from "./auth";
import type { Mailer } from "./mail/mailer";
import {
	renderSignInEmail,
	renderStandaloneSignInEmail,
} from "./mail/templates";

export interface SignInBagValue {
	url?: string;
	otp?: string;
}

/**
 * Contexte d'un `startSignIn` en cours : les callbacks d'email de Better Auth y déposent
 * le lien et le code au lieu d'envoyer chacun leur email.
 */
export const signInBag = new AsyncLocalStorage<SignInBagValue>();

/** Callback `sendMagicLink` de Better Auth. */
export async function onMagicLink(
	url: string,
	email: string,
	mailer: Mailer,
): Promise<void> {
	const bag = signInBag.getStore();
	if (bag) {
		bag.url = url;
		return;
	}
	await mailer.send({ to: email, ...renderStandaloneSignInEmail({ url }) });
}

/** Callback `sendVerificationOTP` de Better Auth. */
export async function onOtp(
	otp: string,
	email: string,
	mailer: Mailer,
): Promise<void> {
	const bag = signInBag.getStore();
	if (bag) {
		bag.otp = otp;
		return;
	}
	await mailer.send({ to: email, ...renderStandaloneSignInEmail({ otp }) });
}

/**
 * Crée le lien magique et le code OTP pour `email` (déjà normalisé), puis envoie
 * **un seul** email qui contient les deux.
 */
export async function startSignIn(
	auth: Auth,
	mailer: Mailer,
	{
		email,
		locale,
		headers,
	}: { email: string; locale: Locale; headers: Headers },
): Promise<void> {
	const bag: SignInBagValue = {};
	await signInBag.run(bag, async () => {
		await auth.api.signInMagicLink({
			body: { email, callbackURL: "/auth/callback" },
			headers,
		});
		await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
	});
	// Garde-fou : si Better Auth exécutait un callback en arrière-plan (hors de notre
	// contexte, ou après le retour), on refuse d'envoyer un email incomplet.
	if (!bag.url)
		throw new Error("startSignIn : lien magique non reçu de Better Auth");
	if (!bag.otp)
		throw new Error("startSignIn : code OTP non reçu de Better Auth");
	await mailer.send({
		to: email,
		...renderSignInEmail({ locale, url: bag.url, otp: bag.otp }),
	});
}
