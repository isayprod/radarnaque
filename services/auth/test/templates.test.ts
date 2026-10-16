import { describe, expect, test } from "vitest";
import { renderSignInEmail } from "../src/mail/templates";

describe("renderSignInEmail", () => {
	test("FR/NL sign-in email contains link and 6-digit code", () => {
		for (const locale of ["fr", "nl"] as const) {
			const m = renderSignInEmail({
				locale,
				url: "https://x/auth/magic-link/verify?token=t",
				otp: "123456",
			});
			expect(m.html).toContain("https://x/auth/magic-link/verify?token=t");
			expect(m.html).toContain("123456");
			expect(m.text).toContain("https://x/auth/magic-link/verify?token=t");
			expect(m.text).toContain("123456");
		}
		expect(
			renderSignInEmail({ locale: "nl", url: "u", otp: "1" }).subject,
		).not.toEqual(
			renderSignInEmail({ locale: "fr", url: "u", otp: "1" }).subject,
		);
	});

	test("mentions the 10-minute validity in each language", () => {
		const fr = renderSignInEmail({ locale: "fr", url: "u", otp: "123456" });
		const nl = renderSignInEmail({ locale: "nl", url: "u", otp: "123456" });
		expect(fr.text).toContain("10 minutes");
		expect(fr.html).toContain("10 minutes");
		expect(nl.text).toContain("10 minuten");
		expect(nl.html).toContain("10 minuten");
	});

	test("escapes interpolated values in the HTML", () => {
		const m = renderSignInEmail({
			locale: "fr",
			url: 'https://x/?a=1&b="2"<script>',
			otp: "<b>1</b>",
		});
		expect(m.html).not.toContain("<script>");
		expect(m.html).not.toContain("<b>1</b>");
		expect(m.html).toContain(
			"https://x/?a=1&amp;b=&quot;2&quot;&lt;script&gt;",
		);
		expect(m.html).toContain("&lt;b&gt;1&lt;/b&gt;");
	});
});
