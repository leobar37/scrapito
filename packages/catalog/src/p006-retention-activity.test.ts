import { describe, expect, test } from "bun:test";
import {
  OfferSearchInputSchema,
  type ProductInput,
  type RetentionRequest,
} from "@scrapito/contracts";
import { CatalogQueries } from "./read/index.ts";
import { openCatalogWriter, WriterLease, type CatalogWriter } from "./write/index.ts";

const COVERAGE_LIMITS = { maxRequests: null, maxDurationMs: null, requestedPages: null } as const;
const PRODUCT: ProductInput = {
  store: "ripley-pe",
  externalId: "p006-product",
  canonicalUrl: "https://simple.ripley.com.pe/p006-product",
  name: "P006 Product",
  sponsored: false,
  attributes: {},
  categories: [],
  images: [],
  price: { regularCents: 10_000, offerCents: 9_000, cardCents: null, currency: "PEN", inStock: true },
  variants: [],
  variantsObserved: true,
};

function currentOffers(queries: CatalogQueries, seenAfter?: string) {
  return queries.searchOffers(OfferSearchInputSchema.parse({ limit: 20, ...(seenAfter ? { seenAfter } : {}) })).data;
}

function startCategoryCoverage(writer: CatalogWriter, externalId = "p006-category") {
  const runId = writer.runs.start("fixture", "ripley-pe");
  const coverage = writer.runs.startCoverage(runId, {
    ...COVERAGE_LIMITS,
    target: { kind: "category" as const, externalId },
  });
  return { runId, ...coverage };
}

function finishComplete(
  writer: CatalogWriter,
  coverageId: number,
  productsSeen: number,
  inactivityMissThreshold: number | null = null,
) {
  return writer.runs.finishCoverage(coverageId, {
    status: "complete",
    authoritative: true,
    stopReason: "completed",
    requestsMade: 1,
    productsSeen,
    duplicatesSeen: 0,
    productsRejected: 0,
    boundary: { complete: true },
    inactivityMissThreshold,
  });
}

describe("P-006 deterministic inactivity and freshness", () => {
  test("only complete authoritative misses reach the threshold; a sighting reactivates and current reads stay neutral", () => {
    const writer = openCatalogWriter(":memory:", { migrate: true });
    try {
      const queries = new CatalogQueries(writer.db);
      const initial = startCategoryCoverage(writer);
      const snapshot = writer.catalog.productSnapshot(initial.runId, "ripley-pe", PRODUCT, [], {
        coverageId: initial.coverageId,
      });
      finishComplete(writer, initial.coverageId, 1, 2);
      expect(currentOffers(queries).map((offer) => offer.id)).toContain(snapshot.productId);

      const partial = startCategoryCoverage(writer);
      const partialResult = writer.runs.finishCoverage(partial.coverageId, {
        status: "partial",
        authoritative: false,
        stopReason: "budget_exhausted",
        requestsMade: 1,
        productsSeen: 0,
        duplicatesSeen: 0,
        productsRejected: 0,
        boundary: null,
      });
      expect(partialResult).toEqual({ membershipsMissed: 0, membershipsInactivated: 0 });

      const homepageRun = writer.runs.start("fixture", "ripley-pe");
      const homepage = writer.runs.startCoverage(homepageRun, {
        ...COVERAGE_LIMITS,
        target: { kind: "homepage" },
      });
      const homepageResult = writer.runs.finishCoverage(homepage.coverageId, {
        status: "complete",
        authoritative: false,
        stopReason: "completed",
        requestsMade: 1,
        productsSeen: 0,
        duplicatesSeen: 0,
        productsRejected: 0,
        boundary: null,
      });
      expect(homepageResult).toEqual({ membershipsMissed: 0, membershipsInactivated: 0 });

      const firstMiss = startCategoryCoverage(writer);
      expect(finishComplete(writer, firstMiss.coverageId, 0, 2)).toEqual({
        membershipsMissed: 1,
        membershipsInactivated: 0,
      });
      const secondMiss = startCategoryCoverage(writer);
      expect(finishComplete(writer, secondMiss.coverageId, 0, 2)).toEqual({
        membershipsMissed: 1,
        membershipsInactivated: 1,
      });
      expect(queries.listTargetMemberships(initial.targetId)).toEqual([]);
      expect(queries.listTargetMemberships(initial.targetId, { includeInactive: true })[0]?.inactivityReason).toBe(
        "complete_coverage_miss",
      );
      expect(currentOffers(queries).map((offer) => offer.id)).not.toContain(snapshot.productId);

      const reactivation = startCategoryCoverage(writer);
      writer.catalog.productSnapshot(reactivation.runId, "ripley-pe", PRODUCT, [], {
        coverageId: reactivation.coverageId,
      });
      writer.runs.finishCoverage(reactivation.coverageId, {
        status: "complete",
        authoritative: false,
        stopReason: "completed",
        requestsMade: 1,
        productsSeen: 1,
        duplicatesSeen: 0,
        productsRejected: 0,
        boundary: null,
      });
      const active = queries.listTargetMemberships(initial.targetId)[0];
      expect(active?.inactiveAt).toBeNull();
      expect(active?.consecutiveCompleteMisses).toBe(0);
      expect(currentOffers(queries).map((offer) => offer.id)).toContain(snapshot.productId);

      const future = new Date(Date.now() + 60_000).toISOString();
      expect(currentOffers(queries, future)).toEqual([]);
      expect(currentOffers(queries).map((offer) => offer.id)).toContain(snapshot.productId);
    } finally {
      writer.close();
    }
  });
});

describe("P-006 explicit retention", () => {
  test("dry-run, bounded batches, lease, replay and repeated compaction preserve price history/drop/low", () => {
    const writer = openCatalogWriter(":memory:", { migrate: true });
    try {
      const queries = new CatalogQueries(writer.db);
      const prices = [9_000, 9_000, 8_000, 8_000];
      let productId = 0;
      for (const offerCents of prices) {
        const coverage = startCategoryCoverage(writer, "retention-category");
        const snapshot = writer.catalog.productSnapshot(
          coverage.runId,
          "ripley-pe",
          { ...PRODUCT, price: { ...PRODUCT.price, offerCents } },
          [],
          { coverageId: coverage.coverageId },
        );
        productId = snapshot.productId;
        writer.runs.finishCoverage(coverage.coverageId, {
          status: "complete",
          authoritative: false,
          stopReason: "completed",
          requestsMade: 1,
          productsSeen: 1,
          duplicatesSeen: 0,
          productsRejected: 0,
          boundary: null,
        });
      }

      const historyBefore = queries.getOfferHistory(productId);
      const movementsBefore = queries.getPriceMovements(productId);
      const dropsBefore = queries.searchCurrentPriceDrops();
      const priceCountBefore =
        writer.db
          .query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM price_observations WHERE product_id=?")
          .get(productId)?.count ?? 0;
      expect(priceCountBefore).toBe(2);
      expect(writer.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM product_sightings").get()?.count).toBe(4);

      const token = writer.writerLease.acquire();
      writer.writerLease.startHeartbeat();
      const competingLease = new WriterLease(writer.db);
      expect(() => competingLease.acquire()).toThrow(/held by another/);
      const baseRequest = {
        schemaVersion: 1,
        sightingsBefore: new Date(Date.now() + 60_000).toISOString(),
      } as const;
      const dryRun = writer.retention.run(
        { ...baseRequest, invocationId: "retention-dry", dryRun: true, batchSize: 1 },
        token,
      );
      expect(dryRun).toMatchObject({ candidates: 1, sightingsDeleted: 0, hasMore: true, replayed: false });
      expect(writer.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM product_sightings").get()?.count).toBe(4);

      const boundedRequest: RetentionRequest = {
        ...baseRequest,
        invocationId: "retention-live-1",
        dryRun: false,
        batchSize: 1,
      };
      const bounded = writer.retention.run(boundedRequest, token);
      expect(bounded).toMatchObject({ candidates: 1, sightingsDeleted: 1, hasMore: true, replayed: false });
      expect(writer.retention.run(boundedRequest, token)).toMatchObject({
        auditId: bounded.auditId,
        sightingsDeleted: 1,
        replayed: true,
      });

      const remaining = writer.retention.run(
        { ...baseRequest, invocationId: "retention-live-2", dryRun: false, batchSize: 10 },
        token,
      );
      expect(remaining).toMatchObject({ candidates: 1, sightingsDeleted: 1, hasMore: false });
      const idempotent = writer.retention.run(
        { ...baseRequest, invocationId: "retention-live-3", dryRun: false, batchSize: 10 },
        token,
      );
      expect(idempotent).toMatchObject({ candidates: 0, sightingsDeleted: 0, hasMore: false });

      expect(queries.getOfferHistory(productId)).toEqual(historyBefore);
      expect(queries.getPriceMovements(productId)).toEqual(movementsBefore);
      expect(queries.searchCurrentPriceDrops()).toEqual(dropsBefore);
      expect(
        writer.db
          .query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM price_observations WHERE product_id=?")
          .get(productId)?.count,
      ).toBe(priceCountBefore);
      expect(writer.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM retention_runs").get()?.count).toBe(4);
    } finally {
      writer.writerLease.release();
      writer.close();
    }
  });
});
