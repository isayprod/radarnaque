import { describe, expect, test } from "vitest";
import type { Listing } from "../lib/listing/types";
import type { ScanRequest } from "../lib/messages";
import type { Signal } from "../lib/rules/rules";
import { BOUNDS, ScanPayloadError, toScanIn } from "../lib/scan-payload";

function listing(overrides: Partial<Listing> = {}): Listing {
	return {
		site: "2ememain.be",
		externalId: "m123",
		url: "https://www.2ememain.be/v/velo/m123",
		title: "Vélo de course",
		description: "Très bon état.",
		price: { amountCents: 15000, currency: "EUR" },
		priceType: "fixed",
		location: { city: "Namur" },
		images: ["https://img.example/1.jpg"],
		seller: {},
		...overrides,
	};
}

function request(overrides: Partial<ScanRequest> = {}): ScanRequest {
	return {
		listing: listing(),
		signals: [],
		rulesVersion: 2,
		scanKind: "text",
		trigger: "button",
		partial: false,
		...overrides,
	};
}

/** Longueur en points de code, comme le serveur la compte. */
function codePoints(s: string | null | undefined): number {
	return Array.from(s ?? "").length;
}

describe("toScanIn", () => {
	test("seller identity never leaves the browser", () => {
		const body = toScanIn(
			request({
				listing: listing({
					seller: { id: "1", name: "X", profileUrl: "/u/x", reviewCount: 4 },
				}),
			}),
		);
		expect(body.listing.seller).toEqual({ reviewCount: 4 });
		const json = JSON.stringify(body);
		expect(json).not.toContain('"X"');
		expect(json).not.toContain("/u/x");
	});

	test("seller facts are kept when defined", () => {
		const seller = {
			accountAgeMonths: { min: 12, max: 24 },
			reviewCount: 0,
			rating: 4.5,
			otherListingsCount: 3,
			verified: false,
			sellerKind: "professional" as const,
		};
		const body = toScanIn(
			request({ listing: listing({ seller: { id: "9", ...seller } }) }),
		);
		expect(body.listing.seller).toEqual(seller);
	});

	test.each(["private", "professional"] as const)(
		"sellerKind %s is passed through",
		(sellerKind) => {
			const body = toScanIn(
				request({ listing: listing({ seller: { name: "X", sellerKind } }) }),
			);
			expect(body.listing.seller).toEqual({ sellerKind });
		},
	);

	test("absent sellerKind stays absent", () => {
		const body = toScanIn(
			request({ listing: listing({ seller: { reviewCount: 2 } }) }),
		);
		expect(body.listing.seller).not.toHaveProperty("sellerKind");
	});

	test.each(["on_request", "see_description", "exchange", "reserved"] as const)(
		"priceType %s is passed as is",
		(priceType) => {
			const body = toScanIn(
				request({ listing: listing({ price: null, priceType }) }),
			);
			expect(body.listing.priceType).toBe(priceType);
		},
	);

	test("text fields are truncated to the exact bounds", () => {
		const long = "a".repeat(6000);
		const body = toScanIn(
			request({
				listing: listing({
					title: long,
					description: long,
					category: long,
					condition: long,
					postedAt: long,
					location: { city: long, region: long, country: long },
				}),
			}),
		);
		const l = body.listing;
		expect(codePoints(l.title)).toBe(300);
		expect(codePoints(l.description)).toBe(5000);
		expect(codePoints(l.category)).toBe(200);
		expect(codePoints(l.condition)).toBe(100);
		expect(codePoints(l.postedAt)).toBe(64);
		expect(codePoints(l.location.city)).toBe(100);
		expect(codePoints(l.location.region)).toBe(100);
		expect(codePoints(l.location.country)).toBe(100);
		expect(BOUNDS).toMatchObject({
			title: 300,
			description: 5000,
			images: 10,
			category: 200,
			condition: 100,
			postedAt: 64,
			location: 100,
			signals: 20,
			paramEntries: 10,
			paramKey: 40,
			paramString: 200,
		});
	});

	test("truncation never cuts an emoji in half", () => {
		const body = toScanIn(
			request({ listing: listing({ title: "😀".repeat(400) }) }),
		);
		expect(body.listing.title).toBe("😀".repeat(300));
	});

	test("keeps the first 10 images and the first 20 signals", () => {
		const images = Array.from(
			{ length: 15 },
			(_, i) => `https://img.example/${i}.jpg`,
		);
		const signals: Signal[] = Array.from({ length: 25 }, (_, i) => ({
			id: i % 2 ? "few_photos" : "no_reviews",
			weight: i,
			severity: "info",
		}));
		const body = toScanIn(request({ listing: listing({ images }), signals }));
		expect(body.listing.images).toEqual(images.slice(0, 10));
		expect(body.rules.signals).toHaveLength(20);
		expect(body.rules.signals.map((s) => s.weight)).toEqual(
			Array.from({ length: 20 }, (_, i) => i),
		);
	});

	test("params: strings cut to 200, decimals dropped, at most 10 entries", () => {
		const params: Record<string, string | number> = {
			text: "b".repeat(250),
			ratio: 1.5,
			count: 3,
		};
		for (let i = 0; i < 12; i++) params[`k${i}`] = i;
		const body = toScanIn(
			request({
				signals: [
					{ id: "price_anomaly", weight: 20, severity: "danger", params },
				],
			}),
		);
		const out = body.rules.signals[0]?.params ?? {};
		expect(out.text).toBe("b".repeat(200));
		expect(out).not.toHaveProperty("ratio");
		expect(out.count).toBe(3);
		expect(Object.keys(out)).toEqual([
			"text",
			"count",
			"k0",
			"k1",
			"k2",
			"k3",
			"k4",
			"k5",
			"k6",
			"k7",
		]);
	});

	test("params: invalid keys and values are dropped; nothing left → no params", () => {
		const body = toScanIn(
			request({
				signals: [
					{
						id: "few_photos",
						weight: 5,
						severity: "info",
						params: {
							"": 1,
							["x".repeat(41)]: 2,
							nan: Number.NaN,
							inf: Number.POSITIVE_INFINITY,
							bad: { nested: true } as unknown as string,
						},
					},
					{ id: "no_reviews", weight: 5, severity: "info" },
				],
			}),
		);
		expect(body.rules.signals[0]).not.toHaveProperty("params");
		expect(body.rules.signals[1]).not.toHaveProperty("params");
		expect(
			toScanIn(
				request({
					signals: [
						{
							id: "few_photos",
							weight: 5,
							severity: "info",
							params: { ["x".repeat(40)]: 1 },
						},
					],
				}),
			).rules.signals[0]?.params,
		).toEqual({ ["x".repeat(40)]: 1 });
	});

	test("an empty title after trim fails locally with invalid_listing", () => {
		const error = (() => {
			try {
				toScanIn(request({ listing: listing({ title: "   " }) }));
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(ScanPayloadError);
		expect((error as ScanPayloadError).code).toBe("invalid_listing");
	});

	test("the title is trimmed, other fields are not", () => {
		const body = toScanIn(
			request({
				listing: listing({ title: "  Vélo  ", description: "  état  " }),
			}),
		);
		expect(body.listing.title).toBe("Vélo");
		expect(body.listing.description).toBe("  état  ");
	});

	test("rules, scanKind, trigger and partial come from the request", () => {
		const signal: Signal = {
			id: "price_anomaly",
			weight: 20,
			severity: "danger",
			params: { medianCents: 30000 },
		};
		const body = toScanIn(
			request({
				signals: [signal],
				rulesVersion: 7,
				scanKind: "image",
				trigger: "card",
				partial: true,
			}),
		);
		expect(body.rules).toEqual({
			version: 7,
			signals: [
				{
					id: "price_anomaly",
					weight: 20,
					severity: "danger",
					params: { medianCents: 30000 },
				},
			],
		});
		expect(body.scanKind).toBe("image");
		expect(body.trigger).toBe("card");
		expect(body.partial).toBe(true);
	});

	test("absent optional fields stay absent, never an empty string", () => {
		const body = toScanIn(
			request({
				listing: listing({ location: {}, price: null, seller: {} }),
			}),
		);
		const l = body.listing;
		for (const key of ["category", "condition", "postedAt"] as const) {
			expect(l[key] ?? null).toBeNull();
			expect(l).not.toHaveProperty(key);
		}
		expect(l.location).toEqual({});
		expect(l.seller).toEqual({});
		expect(l.price).toBeNull();
		expect(JSON.stringify(body)).not.toContain('""');
		expect(l).toMatchObject({
			site: "2ememain.be",
			externalId: "m123",
			url: "https://www.2ememain.be/v/velo/m123",
			priceType: "fixed",
		});
	});
});
