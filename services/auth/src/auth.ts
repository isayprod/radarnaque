import { betterAuth } from "better-auth";
import { admin, bearer, emailOTP, jwt, magicLink } from "better-auth/plugins";
import type { Pool } from "pg";
import type { Env } from "./env";
import type { Mailer } from "./mail/mailer";
import { escapeHtml } from "./mail/templates";

/** Durée de validité commune du lien magique et du code OTP (secondes). */
export const SIGN_IN_TTL_SECONDS = 600;
export const OTP_LENGTH = 6;

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
		trustedOrigins: [env.PUBLIC_URL, `chrome-extension://${env.EXTENSION_ID}`],
		rateLimit: { enabled: true },
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
			// TODO(tâche 8) : déléguer à sign-in.ts (email combiné lien + code, FR/NL).
			magicLink({
				expiresIn: SIGN_IN_TTL_SECONDS,
				sendMagicLink: async ({ email, url }) => {
					await mailer.send({
						to: email,
						subject: "Radarnaque",
						html: `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
						text: url,
					});
				},
			}),
			emailOTP({
				otpLength: OTP_LENGTH,
				expiresIn: SIGN_IN_TTL_SECONDS,
				sendVerificationOTP: async ({ email, otp }) => {
					await mailer.send({
						to: email,
						subject: "Radarnaque",
						html: `<p>${escapeHtml(otp)}</p>`,
						text: otp,
					});
				},
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
