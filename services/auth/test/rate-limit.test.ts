import { describe, expect, test } from "vitest";
import { createRateLimiter } from "../src/rate-limit";

describe("createRateLimiter", () => {
	test("allows max hits per key within the window, then refuses", () => {
		let now = 1_000_000;
		const limiter = createRateLimiter({
			max: 5,
			windowMs: 15 * 60_000,
			now: () => now,
		});
		const first = now;
		for (let i = 0; i < 5; i++) {
			expect(limiter.hit("a")).toBe(true);
			now += 1;
		}
		expect(limiter.hit("a")).toBe(false);
		// Une autre clé a son propre compteur.
		expect(limiter.hit("b")).toBe(true);
		// Un refus ne prolonge pas la fenêtre : juste avant l'expiration du 1er hit, toujours refusé…
		now = first + 15 * 60_000 - 1;
		expect(limiter.hit("a")).toBe(false);
		// …puis le 1er hit sort de la fenêtre glissante.
		now = first + 15 * 60_000;
		expect(limiter.hit("a")).toBe(true);
		expect(limiter.hit("a")).toBe(false);
	});
});
