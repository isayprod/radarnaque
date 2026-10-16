import { betterAuth } from "better-auth";
import { admin, bearer, emailOTP, jwt, magicLink } from "better-auth/plugins";
import type { Pool } from "pg";
import type { Env } from "./env";
import type { Mailer } from "./mail/mailer";
import { onMagicLink, onOtp } from "./sign-in";

/** Durée de validité commune du lien magique et du code OTP (secondes). */
export const SIGN_IN_TTL_SECONDS = 600;
export const OTP_LENGTH = 6;

/** Origines autorisées : le site (origine unique) et l'extension. */
export function trustedOrigins(
	env: Pick<Env, "PUBLIC_URL" | "EXTENSION_ID">,
): string[] {
	return [env.PUBLIC_URL, `chrome-extension://${env.EXTENSION_ID}`];
}

export interface CreateAuthOptions {
	pool: Pool;
	env: Env;
	mailer: Mailer;
	/** Appelé après la création d'un utilisateur (bootstrap côté API). Ses erreurs sont journalisées, jamais propagées. */
	onUserCreated: (userId: string) => Promise<void>;
}

export function createAuth({
	pool,
	env,
	mailer,
	onUserCreated,
}: CreateAuthOptions) {
	return betterAuth({
		appName: "Radarnaque",
		basePath: "/auth",
		baseURL: env.PUBLIC_URL,
		secret: env.BETTER_AUTH_SECRET,
		database: pool,
		trustedOrigins: trustedOrigins(env),
		rateLimit: { enabled: true },
		advanced: {
			// Derrière Caddy : l'IP du client (rate limiting, sessions) vient de X-Forwarded-For.
			ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
			// Better Auth désactive ce contrôle quand NODE_ENV=test : on le force pour que
			// les tests vérifient le comportement de production.
			disableOriginCheck: false,
		},
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						try {
							await onUserCreated(user.id);
						} catch (error) {
							console.error(
								`[auth] onUserCreated a échoué pour l'utilisateur ${user.id} ; la connexion continue`,
								error,
							);
						}
					},
				},
			},
		},
		plugins: [
			// Les deux callbacks passent par sign-in.ts : dans `/auth/start`, ils alimentent un
			// email unique (lien + code) ; ailleurs, chacun envoie un email autonome.
			magicLink({
				expiresIn: SIGN_IN_TTL_SECONDS,
				sendMagicLink: ({ email, url }) => onMagicLink(url, email, mailer),
			}),
			emailOTP({
				otpLength: OTP_LENGTH,
				expiresIn: SIGN_IN_TTL_SECONDS,
				sendVerificationOTP: ({ email, otp }) => onOtp(otp, email, mailer),
			}),
			bearer(),
			jwt({
				jwt: {
					issuer: env.PUBLIC_URL,
					audience: env.PUBLIC_URL,
					expirationTime: "15m",
					definePayload: () => ({}),
				},
				jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
			}),
			admin(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;
