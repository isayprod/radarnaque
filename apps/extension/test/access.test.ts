import type { Me } from "@radarnaque/shared";
import { describe, expect, test } from "vitest";
import { accessOf, canUse, isDebug } from "../lib/access";
import type { ContentAccess } from "../lib/messages";
import { superuserMe, trialMe } from "./helpers";

const standardMe: Me = {
	...trialMe,
	plan: "standard",
	features: [],
	quotas: [{ scanKind: "text", limit: 30, used: 5, remaining: 25 }],
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
	test("un essai donne ses fonctionnalités et ses quotas restants", () => {
		expect(accessOf(trialMe)).toEqual({
			status: "active",
			features: ["card_icons", "image_scan"],
			unlimited: false,
			debug: false,
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
			debug: false,
			remaining: { text: null, image: null, total: null },
		});
	});

	test("un admin sans abonnement reste actif", () => {
		expect(accessOf(adminWithoutPlanMe)).toEqual({
			status: "active",
			features: [],
			unlimited: true,
			debug: false,
			remaining: { text: null, image: null, total: null },
		});
	});

	test("un quota absent vaut null, jamais 0", () => {
		expect(accessOf(standardMe)).toEqual({
			status: "active",
			features: [],
			unlimited: false,
			debug: false,
			remaining: { text: 25, image: null, total: null },
		});
	});
});

describe("superuser", () => {
	test("superuser : actif, illimité, toutes les fonctionnalités et debug", () => {
		expect(accessOf(superuserMe)).toEqual({
			status: "active",
			features: ["card_icons", "image_scan"],
			unlimited: true,
			debug: true,
			remaining: { text: null, image: null, total: null },
		});
	});

	test("superuser : illimité et actif même si l'API omet unlimited et les fonctionnalités", () => {
		const access = accessOf({ ...superuserMe, unlimited: false, features: [] });
		expect(access).toMatchObject({
			status: "active",
			unlimited: true,
			debug: true,
			remaining: { text: null, image: null, total: null },
		});
		for (const feature of ["text", "image", "cards"] as const) {
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

	test("admin : tout, même sans fonctionnalité listée ni abonnement", () => {
		for (const me of [adminMe, adminWithoutPlanMe]) {
			const access = accessOf(me);
			for (const feature of features) {
				expect(canUse(access, feature)).toBe(true);
			}
		}
	});
});
