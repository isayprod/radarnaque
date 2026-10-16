import { betterAuth } from "better-auth";
import { admin, bearer, emailOTP, jwt, magicLink } from "better-auth/plugins";
import type { Pool } from "pg";
import type { Env } from "./env";
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

/**
 * Routes HTTP de Better Auth qui enverraient un email. `/auth/start` est la seule route
 * d'envoi (lien + code en un email, limitée par IP et par email). `disabledPaths` n'agit
 * que sur `auth.handler` : `startSignIn` appelle toujours ces endpoints via `auth.api`.
 */
export const DISABLED_EMAIL_PATHS = [
	"/sign-in/magic-link",
	"/email-otp/send-verification-otp",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/email-otp/request-email-change",
];

export interface CreateAuthOptions {
	pool: Pool;
	env: Env;
	/** Appelé après la création d'un utilisateur (bootstrap côté API). Ses erreurs sont journalisées, jamais propagées. */
	onUserCreated: (userId: string) => Promise<void>;
}

export function createAuth({ pool, env, onUserCreated }: CreateAuthOptions) {
	return betterAuth({
		appName: "Radarnaque",
		basePath: "/auth",
		baseURL: env.PUBLIC_URL,
		secret: env.BETTER_AUTH_SECRET,
		database: pool,
		trustedOrigins: trustedOrigins(env),
		disabledPaths: DISABLED_EMAIL_PATHS,
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
			// email unique (lien + code) ; ailleurs, ils refusent d'envoyer.
			magicLink({
				expiresIn: SIGN_IN_TTL_SECONDS,
				sendMagicLink: ({ email, url }) => onMagicLink(url, email),
			}),
			emailOTP({
				otpLength: OTP_LENGTH,
				expiresIn: SIGN_IN_TTL_SECONDS,
				sendVerificationOTP: ({ email, otp }) => onOtp(otp, email),
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
