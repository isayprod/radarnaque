import type { Me } from "@radarnaque/shared";
import { describe, expect, test } from "vitest";
import { accessOf, canUse } from "../lib/access";
import type { ContentAccess } from "../lib/messages";
import { trialMe } from "./helpers";

const standardMe: Me = {
	...trialMe,
	plan: "standard",
	features: [],
	quotas: [{ scanKind: "text", limit: 30, used: 5, remaining: 25 }],
	totalCap: null,
};

const adminMe: Me = {
	...trialMe,
	role: "admin",
	plan: "trial",
	features: [],
	unlimited: true,
};

describe("accessOf", () => {
	test("un essai donne ses fonctionnalités et ses quotas restants", () => {
		expect(accessOf(trialMe)).toEqual({
			status: "active",
			features: ["card_icons", "image_scan"],
			unlimited: false,
			remaining: { text: 3, image: 3, total: 3 },
		});
	});

	test("sans plan, pas d'abonnement", () => {
		expect(accessOf({ ...trialMe, plan: null })).toEqual({
			status: "noSubscription",
		});
	});

	test("un admin n'a aucun quota affiché", () => {
		expect(accessOf(adminMe)).toEqual({
			status: "active",
			features: [],
			unlimited: true,
			remaining: { text: null, image: null, total: null },
		});
	});

	test("un quota absent vaut null, jamais 0", () => {
		expect(accessOf(standardMe)).toEqual({
			status: "active",
			features: [],
			unlimited: false,
			remaining: { text: 25, image: null, total: null },
		});
	});
});

describe("canUse", () => {
	const features = ["text", "image", "cards"] as const;

	test("standard : texte seulement", () => {
		const access = accessOf(standardMe);
		expect(canUse(access, "text")).toBe(true);
		expect(canUse(access, "image")).toBe(false);
		expect(canUse(access, "cards")).toBe(false);
	});

	test("essai : texte, photos et cartes", () => {
		const access = accessOf(trialMe);
		for (const feature of features) expect(canUse(access, feature)).toBe(true);
	});

	test("sans abonnement ou sans compte : rien", () => {
		const cases: ContentAccess[] = [
			{ status: "noSubscription" },
			{ status: "signedOut" },
		];
		for (const access of cases) {
			for (const feature of features) {
				expect(canUse(access, feature)).toBe(false);
			}
		}
	});

	test("admin : tout, même sans fonctionnalité listée", () => {
		const access = accessOf(adminMe);
		for (const feature of features) expect(canUse(access, feature)).toBe(true);
	});
});
