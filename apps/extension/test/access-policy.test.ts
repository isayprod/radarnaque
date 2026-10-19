import { describe, expect, test } from "vitest";
import {
	ACTIVE_TTL_MS,
	createAccessCache,
	isStale,
	RECHECK_MS,
	RELOGIN_CODES,
} from "../lib/content/access-policy";
import type { ContentAccess } from "../lib/messages";

const active: ContentAccess = {
	status: "active",
	features: ["card_icons"],
	unlimited: false,
	debug: false,
	remaining: { text: 3, image: null, total: null },
};

/** Cache avec une horloge réglée depuis le test. */
function clocked() {
	let clock = 1_000;
	const cache = createAccessCache(() => clock);
	return {
		cache,
		advance(ms: number) {
			clock += ms;
		},
		/** Lecture complète : begin puis settle. */
		read(reading: Parameters<typeof cache.settle>[1]) {
			cache.settle(cache.begin(), reading);
		},
	};
}

describe("isStale (R8)", () => {
	test("signedOut : toujours relu", () => {
		expect(isStale({ status: "signedOut" }, 0, 0)).toBe(true);
	});

	test.each([
		["noSubscription", { status: "noSubscription" } as const],
		["erreur", { error: "background_unavailable" }],
	])("%s : relu après 30 s, pas avant", (_, reading) => {
		expect(isStale(reading, 0, RECHECK_MS - 1)).toBe(false);
		expect(isStale(reading, 0, RECHECK_MS)).toBe(true);
	});

	test("active : gardé 5 min", () => {
		expect(isStale(active, 0, ACTIVE_TTL_MS - 1)).toBe(false);
		expect(isStale(active, 0, ACTIVE_TTL_MS)).toBe(true);
	});
});

describe("createAccessCache", () => {
	test("vide : lecture nécessaire", () => {
		const { cache } = clocked();
		expect(cache.current()).toBeNull();
		expect(cache.needsRead()).toBe(true);
	});

	test("active : en cache 5 min à partir du début de la lecture", () => {
		const t = clocked();
		const ticket = t.cache.begin();
		t.advance(1_000);
		t.cache.settle(ticket, active);
		expect(t.cache.current()).toEqual(active);
		t.advance(ACTIVE_TTL_MS - 1_001);
		expect(t.cache.needsRead()).toBe(false);
		t.advance(1);
		expect(t.cache.needsRead()).toBe(true);
		// Toujours affiché jusqu'à la relecture.
		expect(t.cache.current()).toEqual(active);
	});

	test("noSubscription : 30 s ; signedOut : immédiat", () => {
		const t = clocked();
		t.read({ status: "noSubscription" });
		t.advance(RECHECK_MS - 1);
		expect(t.cache.needsRead()).toBe(false);
		t.advance(1);
		expect(t.cache.needsRead()).toBe(true);
		t.read({ status: "signedOut" });
		expect(t.cache.needsRead()).toBe(true);
	});

	test("invalidate : cache vidé, la lecture commencée avant est ignorée", () => {
		const t = clocked();
		t.read(active);
		const before = t.cache.begin();
		t.cache.invalidate();
		expect(t.cache.current()).toBeNull();
		expect(t.cache.needsRead()).toBe(true);
		t.cache.settle(before, active);
		expect(t.cache.current()).toBeNull();
		t.read({ status: "signedOut" });
		expect(t.cache.current()).toEqual({ status: "signedOut" });
	});

	test("réponses dans le désordre : la lecture la plus récente l'emporte", () => {
		const t = clocked();
		const older = t.cache.begin();
		const newer = t.cache.begin();
		t.cache.settle(newer, { status: "noSubscription" });
		t.cache.settle(older, active);
		expect(t.cache.current()).toEqual({ status: "noSubscription" });
	});
});

test("RELOGIN_CODES : session expirée ou non authentifié", () => {
	expect([...RELOGIN_CODES].sort()).toEqual([
		"session_expired",
		"unauthenticated",
	]);
});
