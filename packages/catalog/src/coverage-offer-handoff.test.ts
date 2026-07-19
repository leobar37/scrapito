import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductInput } from "@scrapito/contracts";
import { CatalogQueries } from "./read/queries.ts";
import { openCatalogWriter } from "./write/index.ts";
import { openWriterDatabase, runMigrations } from "./write/db.ts";

function product(externalId: string, regularCents: number): ProductInput {
  return {
    store: "ripley-pe",
    externalId,
    canonicalUrl: `https://simple.ripley.com.pe/${externalId}`,
    name: `Product ${externalId}`,
    brand: "ACME",
    sellerId: "seller-1",
    sellerName: "Seller One",
    sponsored: false,
    attributes: {},
    categories: [],
    images: [],
    price: {
      regularCents,
      offerCents: null,
      cardCents: null,
      currency: "PEN",
      sellerId: "seller-1",
      inStock: true,
    },
    variants: [],
    variantsObserved: true,
  };
}
const COVERAGE_LIMITS = { maxRequests: 4, maxDurationMs: 1000, requestedPages: [1] };

describe("migration 0009 identity snapshots", () => {
  test("applies additively to a temp database and is idempotent through the migration runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapito-0009-"));
    const dbPath = join(dir, "catalog.sqlite");
    const db = openWriterDatabase(dbPath);
    try {
      const first = runMigrations(db);
      expect(first.applied).toContain("0009_product_sighting_identity_snapshot.sql");
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(product_sightings)")
        .all()
        .map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "name_snapshot",
          "brand_snapshot",
          "canonical_url_snapshot",
          "seller_id_snapshot",
          "seller_name_snapshot",
          "identity_snapshot_version",
        ]),
      );
      expect(runMigrations(db).applied).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CatalogQueries.getCoverageOfferHandoff", () => {
  test("preserves price and identity metadata from the exact sighting across later product mutation", () => {
    const writer = openCatalogWriter(":memory:", { migrate: true });
    try {
      const runId = writer.runs.start("fixture", "ripley-pe", {
        invocationId: "inv-handoff",
        strategy: "category",
        capability: "acquire",
      });
      const { coverageId } = writer.runs.startCoverage(runId, {
        ...COVERAGE_LIMITS,
        target: { kind: "category", externalId: "laptops" },
      });
      const first = writer.catalog.productSnapshot(runId, "ripley-pe", product("sku-1", 10_000), [], { coverageId });
      const second = writer.catalog.productSnapshot(runId, "ripley-pe", product("sku-2", 20_000), [], { coverageId });
      writer.runs.finishCoverage(coverageId, {
        status: "partial",
        authoritative: false,
        stopReason: "budget_exhausted",
        requestsMade: 4,
        productsSeen: 2,
        duplicatesSeen: 0,
        productsRejected: 0,
        boundary: { requestedPages: [1], completedPages: [] },
      });
      writer.runs.finish(runId, "partial", {
        productsSaved: 2,
        productsRejected: 0,
        requestsMade: 4,
        imagesDownloaded: 0,
      });

      const laterRunId = writer.runs.start("fixture", "ripley-pe", { invocationId: "inv-later" });
      const laterInput = {
        ...product("sku-1", 5_000),
        name: "Renamed Product",
        brand: "NEW-BRAND",
        canonicalUrl: "https://simple.ripley.com.pe/sku-1-v2",
        sellerId: "seller-2",
        sellerName: "Seller Two",
      };
      const later = writer.catalog.productSnapshot(laterRunId, "ripley-pe", laterInput, []);
      writer.runs.finish(laterRunId, "completed", {
        productsSaved: 1,
        productsRejected: 0,
        requestsMade: 1,
        imagesDownloaded: 0,
      });
      expect(later.priceObservationId).not.toBe(first.priceObservationId);

      const queries = new CatalogQueries(writer.db);
      const page1 = queries.getCoverageOfferHandoff(coverageId, { limit: 1 });
      expect(page1.invocationId).toBe("inv-handoff");
      expect(page1.runId).toBe(runId);
      expect(page1.coverage).toMatchObject({
        coverageId,
        status: "partial",
        authoritative: false,
        stopReason: "budget_exhausted",
        boundary: { requestedPages: [1], completedPages: [] },
      });
      expect(page1.data).toHaveLength(1);
      expect(page1.data[0]?.productId).toBe(first.productId);
      expect(page1.data[0]?.price.observationId).toBe(first.priceObservationId);
      expect(page1.data[0]?.price.effectiveCents).toBe(10_000);
      expect(page1.data[0]).toMatchObject({
        name: "Product sku-1",
        brand: "ACME",
        url: "https://simple.ripley.com.pe/sku-1",
        seller: { id: "seller-1", name: "Seller One" },
      });
      expect(page1.data[0]?.movement).toMatchObject({
        previousObservationId: null,
        priorHistoricalLowCents: null,
        currentHistoricalLowCents: 10_000,
        isPriceDrop: false,
        isHistoricalLow: false,
      });
      expect(queries.listProductSightings(first.productId)[0]).toEqual({
        id: first.sightingId!,
        coverageId,
        productId: first.productId,
        priceObservationId: first.priceObservationId,
        seenAt: expect.any(String),
        sourceHash: null,
      });
      expect(page1.nextCursor).not.toBeNull();

      const page2 = queries.getCoverageOfferHandoff(coverageId, { limit: 1, cursor: page1.nextCursor! });
      expect(page2.data.map((offer) => offer.productId)).toEqual([second.productId]);
      expect(page2.data[0]?.price.observationId).toBe(second.priceObservationId);
      expect(page2.nextCursor).toBeNull();
    } finally {
      writer.close();
    }
  });

  test("fails clearly for missing, legacy, malformed and cross-coverage cursors", () => {
    const writer = openCatalogWriter(":memory:", { migrate: true });
    try {
      const queries = new CatalogQueries(writer.db);
      expect(() => queries.getCoverageOfferHandoff(999)).toThrow(/coverage not found: 999/);

      const legacyRun = writer.runs.start("legacy", "ripley-pe");
      const legacyCoverage = writer.runs.startCoverage(legacyRun, {
        ...COVERAGE_LIMITS,
        target: { kind: "category", externalId: "legacy" },
      });
      expect(() => queries.getCoverageOfferHandoff(legacyCoverage.coverageId)).toThrow(/legacy run without invocationId/);

      const snapshotRun = writer.runs.start("legacy-snapshot", "ripley-pe", {
        invocationId: "inv-before-0009",
      });
      const snapshotCoverage = writer.runs.startCoverage(snapshotRun, {
        ...COVERAGE_LIMITS,
        target: { kind: "category", externalId: "legacy-snapshot" },
      });
      writer.catalog.productSnapshot(snapshotRun, "ripley-pe", product("legacy-snapshot", 3000), [], {
        coverageId: snapshotCoverage.coverageId,
      });
      writer.db
        .query(
          `UPDATE product_sightings
              SET name_snapshot=NULL,
                  brand_snapshot=NULL,
                  canonical_url_snapshot=NULL,
                  seller_id_snapshot=NULL,
                  seller_name_snapshot=NULL,
                  identity_snapshot_version=NULL
            WHERE coverage_id=?`,
        )
        .run(snapshotCoverage.coverageId);
      expect(() => queries.getCoverageOfferHandoff(snapshotCoverage.coverageId)).toThrow(
        /legacy sightings without immutable identity snapshots/,
      );

      const run = writer.runs.start("fixture", "ripley-pe", { invocationId: "inv-cursors" });
      const coverageA = writer.runs.startCoverage(run, {
        ...COVERAGE_LIMITS,
        target: { kind: "category", externalId: "a" },
      });
      const coverageB = writer.runs.startCoverage(run, {
        ...COVERAGE_LIMITS,
        target: { kind: "category", externalId: "b" },
      });
      writer.catalog.productSnapshot(run, "ripley-pe", product("cursor-1", 1000), [], {
        coverageId: coverageA.coverageId,
      });
      writer.catalog.productSnapshot(run, "ripley-pe", product("cursor-2", 2000), [], {
        coverageId: coverageA.coverageId,
      });
      const cursor = queries.getCoverageOfferHandoff(coverageA.coverageId, { limit: 1 }).nextCursor!;
      expect(() => queries.getCoverageOfferHandoff(coverageA.coverageId, { cursor: "not-json" })).toThrow(
        /malformed coverage offer cursor/,
      );
      expect(() => queries.getCoverageOfferHandoff(coverageB.coverageId, { cursor })).toThrow(
        /different coverage/,
      );
    } finally {
      writer.close();
    }
  });
});
