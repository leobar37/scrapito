import { describe, expect, test } from "bun:test";
import {
  CoverageOfferHandoffQuerySchema,
  CoverageOfferHandoffSchema,
  EvidenceBackedOfferSchema,
} from "./coverage-handoff.ts";

const offer = {
  productId: 7,
  storeId: "ripley-pe",
  externalId: "sku-7",
  name: "Laptop",
  brand: "ACME",
  seller: { id: "seller-1", name: "Seller" },
  url: "https://simple.ripley.com.pe/sku-7",
  currency: "PEN",
  price: {
    observationId: 12,
    observedAt: "2026-07-18T10:00:00.000Z",
    regularCents: 10000,
    offerCents: 8000,
    cardCents: null,
    effectiveCents: 8000,
    access: "public",
    inStock: true,
  },
  movement: {
    previousObservationId: 11,
    previousEffectiveCents: 9000,
    previousAccess: "public",
    priorHistoricalLowCents: 9000,
    currentHistoricalLowCents: 8000,
    isPriceDrop: true,
    isHistoricalLow: true,
    sellerChanged: false,
  },
  evidence: {
    sightingId: 20,
    seenAt: "2026-07-18T10:00:01.000Z",
    coverageId: 3,
    sourceHash: "sha256-value",
  },
} as const;
const handoff = CoverageOfferHandoffSchema.parse({
  invocationId: "inv-3",
  runId: 2,
  site: "ripley-pe",
  coverage: {
    coverageId: 3,
    status: "partial",
    authoritative: false,
    startedAt: "2026-07-18T10:00:00.000Z",
    finishedAt: "2026-07-18T10:00:02.000Z",
    boundary: { requestedPages: [1] },
    stopReason: "budget_exhausted",
  },
  data: [EvidenceBackedOfferSchema.parse(offer)],
  nextCursor: "opaque",
});

describe("coverage offer handoff contracts", () => {
  test("accepts a neutral evidence-backed offer and partial coverage envelope", () => {
    expect(EvidenceBackedOfferSchema.parse(offer)).toEqual(offer);
    expect(CoverageOfferHandoffSchema.parse(handoff)).toEqual(handoff);
  });

  test("rejects malformed evidence, non-PEN currency and unknown consumer fields", () => {
    expect(EvidenceBackedOfferSchema.safeParse({ ...offer, currency: "USD" }).success).toBe(false);
    expect(
      EvidenceBackedOfferSchema.safeParse({
        ...offer,
        evidence: { ...offer.evidence, coverageId: 0 },
      }).success,
    ).toBe(false);
    expect(CoverageOfferHandoffSchema.safeParse({ ...handoff, discord: { channel: "x" } }).success).toBe(false);
  });

  test("normalizes pagination input and enforces bounds", () => {
    expect(CoverageOfferHandoffQuerySchema.parse({ limit: "25", cursor: "abc" })).toEqual({
      limit: 25,
      cursor: "abc",
    });
    expect(CoverageOfferHandoffQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(CoverageOfferHandoffQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(CoverageOfferHandoffQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });
});
