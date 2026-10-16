import { describe, expect, test, vi } from "vitest";
import { AuthError } from "../lib/auth-client";
import { createJwtProvider } from "../lib/jwt-provider";
import { makeJwt } from "./helpers";

const NOW = 1_800_000_000_000;

describe("jwt provider", () => {
	test("jwt provider caches until 60s before exp and dedupes concurrent refresh", async () => {
		let now = NOW;
		const exp = NOW / 1000 + 15 * 60;
		const first = makeJwt(exp);
		const second = makeJwt(exp + 15 * 60);
		let release: (jwt: string) => void = () => {};
		const fetchJwt = vi
			.fn<(sessionToken: string) => Promise<string>>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValueOnce(second);
		const provider = createJwtProvider({
			getSessionToken: async () => "session-abc",
			fetchJwt,
			now: () => now,
		});

		// Trois appels simultanés : une seule requête.
		const pending = [provider.get(), provider.get(), provider.get()];
		await vi.waitFor(() => expect(fetchJwt).toHaveBeenCalledTimes(1));
		release(first);
		expect(await Promise.all(pending)).toEqual([first, first, first]);
		expect(fetchJwt).toHaveBeenCalledWith("session-abc");

		// Encore valable plus de 60 s : servi depuis la mémoire.
		now = (exp - 61) * 1000;
		expect(await provider.get()).toBe(first);
		expect(fetchJwt).toHaveBeenCalledTimes(1);

		// À moins de 60 s de l'expiration : renouvelé.
		now = (exp - 59) * 1000;
		expect(await provider.get()).toBe(second);
		expect(fetchJwt).toHaveBeenCalledTimes(2);
	});

	test("invalidate forces a new request", async () => {
		const exp = NOW / 1000 + 900;
		const fetchJwt = vi
			.fn<(sessionToken: string) => Promise<string>>()
			.mockResolvedValueOnce(makeJwt(exp, "a"))
			.mockResolvedValueOnce(makeJwt(exp, "b"));
		const provider = createJwtProvider({
			getSessionToken: async () => "s",
			fetchJwt,
			now: () => NOW,
		});
		const a = await provider.get();
		provider.invalidate();
		const b = await provider.get();
		expect(a).not.toBe(b);
		expect(fetchJwt).toHaveBeenCalledTimes(2);
	});

	test("a refresh in flight during invalidate is not cached", async () => {
		const exp = NOW / 1000 + 900;
		let release: (jwt: string) => void = () => {};
		const fetchJwt = vi
			.fn<(sessionToken: string) => Promise<string>>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValueOnce(makeJwt(exp, "fresh"));
		const provider = createJwtProvider({
			getSessionToken: async () => "s",
			fetchJwt,
			now: () => NOW,
		});
		const stale = provider.get();
		await vi.waitFor(() => expect(fetchJwt).toHaveBeenCalledTimes(1));
		provider.invalidate();
		release(makeJwt(exp, "stale"));
		await stale;
		expect(await provider.get()).toBe(makeJwt(exp, "fresh"));
		expect(fetchJwt).toHaveBeenCalledTimes(2);
	});

	test("without a session token → AuthError session_expired, no request", async () => {
		const fetchJwt = vi.fn<(sessionToken: string) => Promise<string>>();
		const provider = createJwtProvider({
			getSessionToken: async () => null,
			fetchJwt,
		});
		const error = await provider.get().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AuthError);
		expect((error as AuthError).code).toBe("session_expired");
		expect(fetchJwt).not.toHaveBeenCalled();
	});

	test("a failed refresh is not cached and the next call retries", async () => {
		const fetchJwt = vi
			.fn<(sessionToken: string) => Promise<string>>()
			.mockRejectedValueOnce(new AuthError("network"))
			.mockResolvedValueOnce(makeJwt(NOW / 1000 + 900));
		const provider = createJwtProvider({
			getSessionToken: async () => "s",
			fetchJwt,
			now: () => NOW,
		});
		await expect(provider.get()).rejects.toBeInstanceOf(AuthError);
		await expect(provider.get()).resolves.toBe(makeJwt(NOW / 1000 + 900));
	});
});
