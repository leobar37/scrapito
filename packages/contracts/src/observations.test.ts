import { describe, expect, test } from "bun:test";
import { deriveEffectivePrice, deriveOffer } from "./offers.ts";
import { TargetIdentityInputSchema, targetIdentityKey } from "./observations.ts";

describe("target identity contracts", () => {
  test.each([
    ["homepage", { kind: "homepage" }, "homepage"],
    ["trending", { kind: "trending" }, "trending"],
    ["category", { kind: "category", externalId: "televisores" }, "category:external-id:televisores"],
    ["product external id", { kind: "product", externalId: "sku-42" }, "product:external-id:sku-42"],
    [
      "product canonical URL",
      { kind: "product", canonicalUrl: "https://www.promart.pe/taladro-42" },
      "product:canonical-url:https://www.promart.pe/taladro-42",
    ],
  ] as const)("parses %s and derives its stable identity key", (_name, input, expectedKey) => {
    const target = TargetIdentityInputSchema.parse(input);
    expect(targetIdentityKey(target)).toBe(expectedKey);
  });

  test.each([
    ["enabled", { kind: "homepage", enabled: true }],
    ["priority", { kind: "homepage", priority: 10 }],
    ["cadence", { kind: "homepage", cadence: "hourly" }],
    ["next due time", { kind: "homepage", nextDueAt: "2026-07-18T12:00:00.000Z" }],
    ["retry state", { kind: "homepage", retry: { attempts: 1 } }],
    ["queue state", { kind: "homepage", queueState: "queued" }],
    ["category scheduling", { kind: "category", externalId: "tools", enabled: true }],
    ["product scheduling", { kind: "product", externalId: "sku-1", enabled: true }],
    ["trending scheduling", { kind: "trending", enabled: true }],
  ])("rejects scheduler-owned %s fields", (_name, input) => {
    expect(TargetIdentityInputSchema.safeParse(input).success).toBe(false);
  });

  test("rejects an ambiguous product identity instead of choosing one locator", () => {
    expect(
      TargetIdentityInputSchema.safeParse({
        kind: "product",
        externalId: "sku-42",
        canonicalUrl: "https://www.promart.pe/taladro-42",
      }).success,
    ).toBe(false);
  });
});

describe("effective price derivation", () => {
  test.each([
    ["all-null legacy row", null, null, null, { effectiveCents: null, priceAccess: null }],
    ["regular-only baseline", 10_000, null, null, { effectiveCents: 10_000, priceAccess: "public" }],
    ["offer public candidate", 10_000, 8_500, null, { effectiveCents: 8_500, priceAccess: "public" }],
    ["strictly cheaper card", 10_000, 8_500, 8_000, { effectiveCents: 8_000, priceAccess: "card" }],
    ["card-only row", null, null, 8_000, { effectiveCents: 8_000, priceAccess: "card" }],
    ["card/public tie", 10_000, 8_000, 8_000, { effectiveCents: 8_000, priceAccess: "public" }],
  ] as const)("handles %s", (_name, regularCents, offerCents, cardCents, expected) => {
    expect(deriveEffectivePrice({ regularCents, offerCents, cardCents })).toEqual(expected);
  });

  test("regular-only participates in temporal history without becoming a legacy offer", () => {
    const regularOnly = { regularCents: 10_000, offerCents: null, cardCents: null };
    expect(deriveEffectivePrice(regularOnly)).toEqual({
      effectiveCents: 10_000,
      priceAccess: "public",
    });
    expect(deriveOffer(regularOnly)).toBeNull();
  });
});
