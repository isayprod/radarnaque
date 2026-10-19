import type { Me } from "@radarnaque/shared";
import { describe, expect, test } from "vitest";
import { accessOf, canUse, isDebug } from "../lib/access";
import type { ContentAccess } from "../lib/messages";
import { superuserMe, trialMe } from "./helpers";

const standardMe: Me = {
	...trialMe,
	plan: "standard",
	features: [],
	maxImages: 1,
	quotas: [{ scanKind: "full", limit: 150, used: 5, remaining: 145 }],
	totalCap: null,
};

// Forme renvoyée par le serveur pour un admin : aucun quota, aucun plafond.
const adminMe: Me = {
	...trialMe,
	role: "admin",
	plan: "trial",
	features: [],
	unlimited: true,
	quotas: [],
	totalCap: null,
};

const adminWithoutPlanMe: Me = { ...adminMe, plan: null };

describe("accessOf", () => {
	test("un essai donne ses fonctionnalités, ses photos et ses scans restants", () => {
		expect(accessOf(trialMe)).toEqual({
			status: "active",
			features: ["card_icons"],
			unlimited: false,
			debug: false,
			maxImages: 4,
			remaining: { scans: 3 },
		});
	});

	test("remaining.scans vient du quota full, limité par totalCap", () => {
		const withCap = (quota: number, cap: number) =>
			accessOf({
				...trialMe,
				quotas: [
					{ scanKind: "full", limit: 10, used: 10 - quota, remaining: quota },
				],
				totalCap: { scanKind: null, limit: 10, used: 10 - cap, remaining: cap },
			});
		expect(withCap(5, 2)).toMatchObject({ remaining: { scans: 2 } });
		expect(withCap(1, 4)).toMatchObject({ remaining: { scans: 1 } });
		expect(withCap(0, 4)).toMatchObject({ remaining: { scans: 0 } });
		// Plafond seul, ou quota seul.
		expect(accessOf({ ...trialMe, quotas: [] })).toMatchObject({
			remaining: { scans: 3 },
		});
		expect(accessOf(standardMe)).toMatchObject({
			maxImages: 1,
			remaining: { scans: 145 },
		});
	});

	test("un quota d'un autre type n'est pas compté", () => {
		expect(
			accessOf({
				...standardMe,
				quotas: [{ scanKind: "text", limit: 30, used: 0, remaining: 30 }],
			}),
		).toMatchObject({ remaining: { scans: null } });
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
			debug: false,
			maxImages: 4,
			remaining: { scans: null },
		});
	});

	test("un admin sans abonnement reste actif", () => {
		expect(accessOf(adminWithoutPlanMe)).toMatchObject({
			status: "active",
			unlimited: true,
			remaining: { scans: null },
		});
	});

	test("un admin à qui l'API renverrait un quota reste sans quota affiché", () => {
		expect(
			accessOf({
				...adminMe,
				totalCap: { scanKind: null, limit: 3, used: 0, remaining: 3 },
			}),
		).toMatchObject({ remaining: { scans: null } });
	});
});

describe("superuser", () => {
	test("superuser : Premium, illimité, debug, 4 photos", () => {
		expect(accessOf(superuserMe)).toEqual({
			status: "active",
			features: ["card_icons"],
			unlimited: true,
			debug: true,
			maxImages: 4,
			remaining: { scans: null },
		});
	});

	test("superuser : illimité et actif même si l'API omet unlimited et les fonctionnalités", () => {
		const access = accessOf({
			...superuserMe,
			plan: null,
			unlimited: false,
			features: [],
		});
		expect(access).toMatchObject({
			status: "active",
			unlimited: true,
			debug: true,
			remaining: { scans: null },
		});
		for (const feature of ["ai", "cards"] as const) {
			expect(canUse(access, feature)).toBe(true);
		}
	});

	test("isDebug : vrai seulement pour un superuser", () => {
		expect(isDebug(accessOf(superuserMe))).toBe(true);
		const others: ContentAccess[] = [
			{ status: "signedOut" },
			{ status: "noSubscription" },
			accessOf(trialMe),
			accessOf(standardMe),
			accessOf(adminMe),
			accessOf(adminWithoutPlanMe),
		];
		for (const access of others) expect(isDebug(access)).toBe(false);
	});
});

describe("canUse", () => {
	const features = ["ai", "cards"] as const;

	test("standard : l'analyse IA seulement", () => {
		const access = accessOf(standardMe);
		expect(canUse(access, "ai")).toBe(true);
		expect(canUse(access, "cards")).toBe(false);
	});

	test("essai : analyse IA et cartes", () => {
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

	test("admin : tout, même sans fonctionnalité listée ni abonnement", () => {
		for (const me of [adminMe, adminWithoutPlanMe]) {
			const access = accessOf(me);
			for (const feature of features) {
				expect(canUse(access, feature)).toBe(true);
			}
		}
	});
});
