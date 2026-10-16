import { describe, expect, test, vi } from "vitest";
import type { Auth } from "../src/auth";
import { MemoryMailer } from "../src/mail/mailer";
import { onMagicLink, onOtp, startSignIn } from "../src/sign-in";

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
			}),
		).rejects.toThrow(/code/);
		expect(mailer.messages).toHaveLength(0);
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
