import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverSession } from "../src/deliver-session";
import { MESSAGES, pickLocale } from "../src/i18n";

afterEach(() => {
	vi.useRealTimers();
});

describe("deliverSession", () => {
	it("returns connected when a token exists and the extension accepts it", async () => {
		const sendToExtension = vi.fn().mockResolvedValue(true);
		const result = await deliverSession({
			fetchToken: async () => "tok",
			sendToExtension,
		});
		expect(result).toBe("connected");
		expect(sendToExtension).toHaveBeenCalledWith("tok");
	});

	it("returns expired without calling the extension when there is no token", async () => {
		const sendToExtension = vi.fn();
		const result = await deliverSession({
			fetchToken: async () => null,
			sendToExtension,
		});
		expect(result).toBe("expired");
		expect(sendToExtension).not.toHaveBeenCalled();
	});

	it("returns no-extension when the extension refuses", async () => {
		const result = await deliverSession({
			fetchToken: async () => "tok",
			sendToExtension: async () => false,
		});
		expect(result).toBe("no-extension");
	});

	it("returns no-extension when sendToExtension rejects", async () => {
		const result = await deliverSession({
			fetchToken: async () => "tok",
			sendToExtension: async () => {
				throw new Error("boom");
			},
		});
		expect(result).toBe("no-extension");
	});

	it("returns expired when fetchToken rejects", async () => {
		const result = await deliverSession({
			fetchToken: async () => {
				throw new Error("network");
			},
			sendToExtension: async () => true,
		});
		expect(result).toBe("expired");
	});

	it("returns no-extension after 3 s when the extension never answers", async () => {
		vi.useFakeTimers();
		const promise = deliverSession({
			fetchToken: async () => "tok",
			sendToExtension: () => new Promise<boolean>(() => {}),
		});
		let settled = false;
		void promise.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(2999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(promise).resolves.toBe("no-extension");
	});
});

describe("i18n", () => {
	for (const state of ["connected", "expired", "no-extension"] as const) {
		it(`has distinct non-empty FR and NL text for ${state}`, () => {
			const { fr, nl } = MESSAGES[state];
			expect(fr.length).toBeGreaterThan(0);
			expect(nl.length).toBeGreaterThan(0);
			expect(fr).not.toBe(nl);
		});
	}

	it("picks nl for nl-* languages, fr otherwise", () => {
		expect(pickLocale("nl-BE")).toBe("nl");
		expect(pickLocale("nl")).toBe("nl");
		expect(pickLocale("fr-BE")).toBe("fr");
		expect(pickLocale("en-US")).toBe("fr");
		expect(pickLocale(undefined)).toBe("fr");
	});
});
