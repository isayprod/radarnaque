import { describe, expect, test } from "vitest";
import type { Auth } from "../src/auth";
import { MemoryMailer } from "../src/mail/mailer";
import { onMagicLink, onOtp, startSignIn } from "../src/sign-in";

const EMAIL = "alice@test.be";

/** Faux Better Auth : appelle (ou non) les callbacks d'email comme le ferait le vrai. */
function fakeAuth(mailer: MemoryMailer, { callOtp = true } = {}): Auth {
	return {
		api: {
			signInMagicLink: async ({ body }: { body: { email: string } }) => {
				await onMagicLink(
					"https://x/auth/magic-link/verify?token=abc",
					body.email,
					mailer,
				);
				return { status: true };
			},
			sendVerificationOTP: async ({ body }: { body: { email: string } }) => {
				if (callOtp) await onOtp("123456", body.email, mailer);
				return { success: true };
			},
		},
	} as unknown as Auth;
}

describe("startSignIn", () => {
	test("collects link and code, then sends exactly one combined email", async () => {
		const mailer = new MemoryMailer();
		await startSignIn(fakeAuth(mailer), mailer, {
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
			startSignIn(fakeAuth(mailer, { callOtp: false }), mailer, {
				email: EMAIL,
				locale: "fr",
				headers: new Headers(),
			}),
		).rejects.toThrow(/code/);
		expect(mailer.messages).toHaveLength(0);
	});
});

describe("email callbacks outside startSignIn", () => {
	test("send a standalone email each", async () => {
		const mailer = new MemoryMailer();
		await onMagicLink(
			"https://x/auth/magic-link/verify?token=zz",
			EMAIL,
			mailer,
		);
		await onOtp("987654", EMAIL, mailer);
		expect(mailer.messages).toHaveLength(2);
		expect(mailer.messages[0].to).toBe(EMAIL);
		expect(mailer.messages[0].text).toContain("token=zz");
		expect(mailer.messages[1].text).toContain("987654");
	});
});
