import { describe, expect, test, vi } from "vitest";
import type { Auth } from "../src/auth";
import { MemoryMailer } from "../src/mail/mailer";
import { onMagicLink, onOtp, parseTarget, startSignIn } from "../src/sign-in";

const EMAIL = "alice@test.be";

/** Faux Better Auth : appelle (ou non) les callbacks d'email comme le ferait le vrai. */
function fakeAuth({ callOtp = true } = {}): Auth {
	return {
		api: {
			signInMagicLink: async ({ body }: { body: { email: string } }) => {
				await onMagicLink(
					"https://x/auth/magic-link/verify?token=abc",
					body.email,
				);
				return { status: true };
			},
			sendVerificationOTP: async ({ body }: { body: { email: string } }) => {
				if (callOtp) await onOtp("123456", body.email);
				return { success: true };
			},
		},
	} as unknown as Auth;
}

describe("startSignIn", () => {
	test("collects link and code, then sends exactly one combined email", async () => {
		const mailer = new MemoryMailer();
		await startSignIn(fakeAuth(), mailer, {
			email: EMAIL,
			locale: "nl",
			headers: new Headers(),
			target: "extension",
		});
		expect(mailer.messages).toHaveLength(1);
		const [msg] = mailer.messages;
		expect(msg.to).toBe(EMAIL);
		expect(msg.subject).toBe("Uw aanmelding bij Radarnaque");
		expect(msg.text).toContain("https://x/auth/magic-link/verify?token=abc");
		expect(msg.text).toContain("123456");
	});

	test("throws instead of sending an incomplete email when a callback did not run", async () => {
		const mailer = new MemoryMailer();
		await expect(
			startSignIn(fakeAuth({ callOtp: false }), mailer, {
				email: EMAIL,
				locale: "fr",
				headers: new Headers(),
				target: "extension",
			}),
		).rejects.toThrow(/code/);
		expect(mailer.messages).toHaveLength(0);
	});
});

describe("startSignIn target", () => {
	/** Faux Better Auth qui garde le corps reçu par `signInMagicLink`. */
	function recordingAuth() {
		const bodies: Record<string, unknown>[] = [];
		const auth = {
			api: {
				signInMagicLink: async ({ body }: { body: { email: string } }) => {
					bodies.push(body);
					await onMagicLink("https://x/auth/magic-link/verify?t=1", body.email);
					return { status: true };
				},
				sendVerificationOTP: async ({ body }: { body: { email: string } }) => {
					await onOtp("123456", body.email);
					return { success: true };
				},
			},
		} as unknown as Auth;
		return { auth, bodies };
	}

	test("extension (par défaut) : callbackURL /auth/callback, sans errorCallbackURL", async () => {
		const { auth, bodies } = recordingAuth();
		await startSignIn(auth, new MemoryMailer(), {
			email: EMAIL,
			locale: "fr",
			headers: new Headers(),
			target: "extension",
		});
		expect(bodies).toEqual([{ email: EMAIL, callbackURL: "/auth/callback" }]);
	});

	test("admin : callbackURL et errorCallbackURL de l'admin, email français même en nl", async () => {
		const { auth, bodies } = recordingAuth();
		const mailer = new MemoryMailer();
		await startSignIn(auth, mailer, {
			email: EMAIL,
			locale: "nl",
			headers: new Headers(),
			target: "admin",
		});
		expect(bodies).toEqual([
			{
				email: EMAIL,
				callbackURL: "/admin/",
				errorCallbackURL: "/admin/?erreur=lien",
			},
		]);
		expect(mailer.messages[0].subject).toBe("Votre connexion à Radarnaque");
		expect(mailer.messages[0].text).toContain("page d'administration");
	});
});

describe("parseTarget", () => {
	test("undefined → extension, valeurs connues acceptées, le reste refusé", () => {
		expect(parseTarget(undefined)).toBe("extension");
		expect(parseTarget("extension")).toBe("extension");
		expect(parseTarget("admin")).toBe("admin");
		for (const value of ["", "Admin", "autre", null, 0, {}, ["admin"]]) {
			expect(parseTarget(value)).toBeNull();
		}
	});
});

describe("email callbacks outside startSignIn", () => {
	test("refuse to send: /auth/start is the only path that sends email", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				onMagicLink("https://x/auth/magic-link/verify?token=zz", EMAIL),
			).rejects.toThrow(/startSignIn/);
			await expect(onOtp("987654", EMAIL)).rejects.toThrow(/startSignIn/);
			expect(errors).toHaveBeenCalledTimes(2);
		} finally {
			errors.mockRestore();
		}
	});
});
