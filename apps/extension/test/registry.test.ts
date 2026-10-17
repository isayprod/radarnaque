import { describe, expect, test } from "vitest";
import { adapterFor } from "../lib/adapters/registry";

describe("adapterFor", () => {
	test.each([
		["https://www.2ememain.be/v/autos/bmw/m123-titre.html", "twh"],
		["https://2ememain.be/", "twh"],
		["https://www.2dehands.be/", "twh"],
		["https://www.facebook.com/marketplace/item/1/", "facebook"],
		["https://facebook.com/marketplace/item/1/", "facebook"],
		["https://web.facebook.com/marketplace/item/1/", "facebook"],
	])("%s -> %s", (url, id) => {
		expect(adapterFor(new URL(url))?.id).toBe(id);
	});

	test.each([
		"https://example.com/",
		"https://www.2ememain.be.evil.com/",
		"https://evil-2ememain.be/",
		"https://evil.com/www.facebook.com/",
		"https://m.facebook.com/marketplace/item/1/",
		"https://web.facebook.com.evil.com/marketplace/item/1/",
	])("%s -> null", (url) => {
		expect(adapterFor(new URL(url))).toBeNull();
	});
});
