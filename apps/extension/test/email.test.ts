import { describe, expect, test } from "vitest";
import { isValidEmail, normalizeEmail } from "../lib/email";

describe("email", () => {
	test("normalizeEmail trims and lowercases", () => {
		expect(normalizeEmail(" A@B.BE ")).toBe("a@b.be");
		expect(normalizeEmail("\tMarie.Dupont@Example.COM\n")).toBe(
			"marie.dupont@example.com",
		);
	});

	test("isValidEmail accepts plain addresses and rejects malformed ones", () => {
		expect(isValidEmail("a@b.be")).toBe(true);
		expect(isValidEmail("marie.dupont+radar@example.co.uk")).toBe(true);
		for (const bad of [
			"",
			"a",
			"a@",
			"@b.be",
			"a@b",
			"a b@c.be",
			"a@@b.be",
			`${"x".repeat(250)}@b.be`,
		]) {
			expect(isValidEmail(bad), bad).toBe(false);
		}
	});
});
