/**
 * P-002 target observation foundation — behavioral tests for migration 0007
 * (additive schema/views/triggers), sighting persistence inside
 * `CatalogStore.productSnapshot`, the P-001 strict price-movement matrix,
 * the "current drop requires a matching post-cutover sighting" contract, and
 * authoritative-coverage membership-miss rules. Every DB is `:memory:` —
 * never `data/scrap.sqlite`.
 */
import { describe, expect, test } from "bun:test";
import type { ProductInput, VariantInput } from "@scrapito/contracts";
import { openWriterDatabase, runMigrations } from "./write/db.ts";
import { openCatalogWriter } from "./write/index.ts";
import { CatalogQueries } from "./read/index.ts";

function openWriter() {
  return openCatalogWriter(":memory:", { migrate: true });
}

function baseProductInput(overrides: Partial<ProductInput> = {}): ProductInput {
  return {
    store: "ripley-pe",
    externalId: "sku-1",
    canonicalUrl: "https://simple.ripley.com.pe/sku-1",
    name: "Test Product",
    sponsored: false,
    attributes: {},
    categories: [],
    images: [],
    price: { regularCents: 10_000, offerCents: null, cardCents: null, currency: "PEN", inStock: true },
    variants: [],
    variantsObserved: true,
    ...overrides,
  } as ProductInput;
}

const NO_VARIANTS: readonly VariantInput[] = [];

const UNBOUNDED_COVERAGE = {
  maxRequests: null,
  maxDurationMs: null,
  requestedPages: null,
} as const;

function assertDefined<T>(value: T | undefined, label: string): asserts value is T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
}

describe("migration 0007 runner and schema", () => {
  test("a clean migration applies every checked-in migration exactly once, in order", () => {
    const db = openWriterDatabase(":memory:");
    const result = runMigrations(db);
    expect(result.alreadyApplied).toEqual([]);
    expect(result.applied[0]).toBe("0001_init.sql");
    expect(result.applied).toContain("0007_target_observation_foundation.sql");
    expect(result.applied).toEqual([...result.applied].sort());
    db.close();
  });

  test("re-running migrations against an already-migrated database is a no-op", () => {
    const db = openWriterDatabase(":memory:");
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
    db.close();
  });

  test("detects a tampered migration checksum instead of silently re-applying", () => {
    const db = openWriterDatabase(":memory:");
    runMigrations(db);
    db.query("UPDATE _migrations SET checksum='deadbeef' WHERE name=?").run(
      "0007_target_observation_foundation.sql",
    );
    expect(() => runMigrations(db)).toThrow(/checksum mismatch/);
    db.close();
  });

  test("backfills a legacy null checksum without re-applying or throwing", () => {
    const db = openWriterDatabase(":memory:");
    runMigrations(db);
    db.query("UPDATE _migrations SET checksum=NULL WHERE name=?").run(
      "0007_target_observation_foundation.sql",
    );
    const result = runMigrations(db);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0007_target_observation_foundation.sql");
    const row = db
      .query<{ checksum: string | null }, [string]>("SELECT checksum FROM _migrations WHERE name=?")
      .get("0007_target_observation_foundation.sql");
    expect(row?.checksum).not.toBeNull();
    db.close();
  });

  test("0007 adds the target/coverage/sighting/membership objects additively", () => {
    const db = openWriterDatabase(":memory:");
    runMigrations(db);
    const objects = db
      .query<{ type: string; name: string }, []>(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table','view','trigger')",
      )
      .all();
    const names = new Set(objects.map((o) => o.name));
    for (const table of [
      "scrape_target_identities",
      "target_coverages",
      "product_sightings",
      "target_product_memberships",
      "price_observations", // unchanged change-log table still present
    ]) {
      expect(names.has(table)).toBe(true);
    }
    for (const view of ["price_observation_movements", "latest_product_sightings", "current_price_drops"]) {
      expect(names.has(view)).toBe(true);
    }
    for (const trigger of [
      "target_coverages_authoritative_kind_insert",
      "target_coverages_authoritative_kind_update",
      "product_sightings_membership_insert",
      "product_sightings_membership_update",
    ]) {
      expect(names.has(trigger)).toBe(true);
    }
    db.close();
  });

  test("product_sightings rejects a price observation that belongs to a different product", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const { coverageId } = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "fk-test" },
      });
      const other = writer.catalog.productSnapshot(runId, "ripley-pe", baseProductInput({ externalId: "fk-a" }), NO_VARIANTS, {
        coverageId,
      });
      const target = writer.catalog.productSnapshot(runId, "ripley-pe", baseProductInput({ externalId: "fk-b" }), NO_VARIANTS);
      expect(() =>
        writer.db
          .query(
            "INSERT INTO product_sightings (coverage_id, product_id, price_observation_id, seen_at, source_hash) VALUES (?,?,?,?,?)",
          )
          .run(coverageId, target.productId, other.priceObservationId, new Date().toISOString(), null),
      ).toThrow();
    } finally {
      writer.close();
    }
  });

  test("schema rejects an authoritative coverage row for a homepage/trending target but allows it for category", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const home = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "homepage" },
      });
      const category = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "trigger-ok" },
      });
      const rawRunId = writer.runs.start("fixture", "ripley-pe");
      const now = new Date().toISOString();
      const insertAuthoritative = (targetId: number) =>
        writer.db
          .query(
            `INSERT INTO target_coverages (run_id, target_id, status, authoritative, started_at, finished_at, stop_reason)
             VALUES (?,?, 'complete', 1, ?, ?, 'completed')`,
          )
          .run(rawRunId, targetId, now, now);

      expect(() => insertAuthoritative(home.targetId)).toThrow(/authoritative/);
      expect(() => insertAuthoritative(category.targetId)).not.toThrow();
    } finally {
      writer.close();
    }
  });
});

describe("CatalogStore snapshot sighting semantics", () => {
  test("the same price vector snapshotted under distinct coverages adds a sighting per coverage but reuses the price row", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const covA = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "cat-a" },
      });
      const covB = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "cat-b" },
      });
      const input = baseProductInput({ externalId: "dual-coverage" });

      const first = writer.catalog.productSnapshot(runId, "ripley-pe", input, NO_VARIANTS, {
        coverageId: covA.coverageId,
      });
      const second = writer.catalog.productSnapshot(runId, "ripley-pe", input, NO_VARIANTS, {
        coverageId: covB.coverageId,
      });

      expect(first.priceInserted).toBe(true);
      expect(second.priceInserted).toBe(false);
      expect(second.priceObservationId).toBe(first.priceObservationId);
      expect(first.sightingInserted).toBe(true);
      expect(second.sightingInserted).toBe(true);
      expect(second.sightingId).not.toBe(first.sightingId);

      const queries = new CatalogQueries(writer.db);
      const sightings = queries.listProductSightings(first.productId);
      expect(sightings.length).toBe(2);
      expect(new Set(sightings.map((s) => s.priceObservationId))).toEqual(new Set([first.priceObservationId]));
      const priceRowCount = writer.db
        .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM price_observations WHERE product_id=?")
        .get(first.productId);
      expect(priceRowCount?.n).toBe(1);
    } finally {
      writer.close();
    }
  });

  test("repeating the same vector in the same coverage updates the existing sighting instead of inserting a new one", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const { coverageId } = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "repeat" },
      });
      const input = baseProductInput({ externalId: "repeat-product" });

      const first = writer.catalog.productSnapshot(runId, "ripley-pe", input, NO_VARIANTS, { coverageId });
      const second = writer.catalog.productSnapshot(runId, "ripley-pe", input, NO_VARIANTS, { coverageId });

      expect(second.sightingInserted).toBe(false);
      expect(second.sightingId).toBe(first.sightingId);
      const count = writer.db
        .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM product_sightings WHERE product_id=?")
        .get(first.productId);
      expect(count?.n).toBe(1);
    } finally {
      writer.close();
    }
  });

  test("legacy callers that omit options create no sighting while the product/price snapshot still succeeds", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const result = writer.catalog.productSnapshot(
        runId,
        "ripley-pe",
        baseProductInput({ externalId: "legacy-product" }),
        NO_VARIANTS,
      );
      expect(result.created).toBe(true);
      expect(result.priceInserted).toBe(true);
      expect(result.sightingId).toBeNull();
      expect(result.sightingInserted).toBe(false);

      const queries = new CatalogQueries(writer.db);
      expect(queries.listProductSightings(result.productId)).toEqual([]);
    } finally {
      writer.close();
    }
  });

  test("productSnapshot rejects a coverage that does not belong to the given store or is no longer running", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const { coverageId } = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "guard" },
      });

      expect(() =>
        writer.catalog.productSnapshot(
          runId,
          "falabella-pe",
          baseProductInput({ store: "falabella-pe", externalId: "wrong-store" }),
          NO_VARIANTS,
          { coverageId },
        ),
      ).toThrow();

      writer.runs.finishCoverage(coverageId, {
        status: "complete",
        authoritative: false,
        stopReason: "completed",
        requestsMade: 1,
        productsSeen: 0,
        productsRejected: 0,
        duplicatesSeen: 0,
        boundary: null,
      });
      expect(() =>
        writer.catalog.productSnapshot(
          runId,
          "ripley-pe",
          baseProductInput({ externalId: "finished-coverage" }),
          NO_VARIANTS,
          { coverageId },
        ),
      ).toThrow();
    } finally {
      writer.close();
    }
  });
});

describe("strict price movement matrix (P-001)", () => {
  test("proves first-observation, rise, equality, strict drop, historical low and the stock gate", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const first = writer.catalog.productSnapshot(
        runId,
        "ripley-pe",
        baseProductInput({ externalId: "movements", price: { regularCents: 10_000, offerCents: null, cardCents: null, currency: "PEN", inStock: true } }),
        NO_VARIANTS,
      );
      const productId = first.productId;
      const firstRow = writer.db
        .query<{ observed_at: string }, [number]>(
          "SELECT observed_at FROM price_observations WHERE id=?",
        )
        .get(first.priceObservationId);
      const baseMs = new Date(firstRow!.observed_at).getTime();

      const insertRow = (offsetMinutes: number, opts: { regularCents?: number | null; offerCents?: number | null; inStock?: boolean }) => {
        const observedAt = new Date(baseMs + offsetMinutes * 60_000).toISOString();
        writer.db
          .query(
            "INSERT INTO price_observations (product_id, observed_at, regular_cents, offer_cents, card_cents, in_stock) VALUES (?,?,?,?,?,?)",
          )
          .run(productId, observedAt, opts.regularCents ?? null, opts.offerCents ?? null, null, opts.inStock === false ? 0 : 1);
      };

      insertRow(1, { regularCents: 12_000 }); // rise: 10000 -> 12000
      insertRow(2, { regularCents: 12_000 }); // equal: 12000 -> 12000
      insertRow(3, { offerCents: 9_000 }); // strict drop + new historical low
      insertRow(4, { offerCents: 7_000, inStock: false }); // cheaper but out of stock: neither flag
      insertRow(5, { offerCents: 6_000 }); // drop compared to the out-of-stock previous, new low

      const queries = new CatalogQueries(writer.db);
      const movements = queries.getPriceMovements(productId);
      expect(movements.map((m) => m.effectiveCents)).toEqual([10_000, 12_000, 12_000, 9_000, 7_000, 6_000]);

      const [obs1, rise, equal, drop, outOfStockCheaper, recoveredDrop] = movements;
      assertDefined(obs1, "first observation");
      assertDefined(rise, "price rise");
      assertDefined(equal, "equal price");
      assertDefined(drop, "price drop");
      assertDefined(outOfStockCheaper, "out-of-stock cheaper price");
      assertDefined(recoveredDrop, "recovered price drop");
      expect(obs1.isPriceDrop).toBe(false);
      expect(obs1.isHistoricalLow).toBe(false);

      expect(rise.isPriceDrop).toBe(false);
      expect(rise.isHistoricalLow).toBe(false);
      expect(rise.previousEffectiveCents).toBe(10_000);

      expect(equal.isPriceDrop).toBe(false);
      expect(equal.isHistoricalLow).toBe(false);
      expect(equal.priorHistoricalLowCents).toBe(10_000);

      expect(drop.isPriceDrop).toBe(true);
      expect(drop.isHistoricalLow).toBe(true);
      expect(drop.priorHistoricalLowCents).toBe(10_000);

      expect(outOfStockCheaper.isPriceDrop).toBe(false);
      expect(outOfStockCheaper.isHistoricalLow).toBe(false);

      // Previous stock does not suppress comparison: the out-of-stock 7000 row
      // is still the "previous" baseline for the next in-stock observation.
      expect(recoveredDrop.previousEffectiveCents).toBe(7_000);
      expect(recoveredDrop.isPriceDrop).toBe(true);
      expect(recoveredDrop.isHistoricalLow).toBe(true);
    } finally {
      writer.close();
    }
  });
});

describe("current price drops require a matching post-cutover sighting", () => {
  test("a drop only surfaces once the latest sighting references the latest price observation", () => {
    const writer = openWriter();
    try {
      const queries = new CatalogQueries(writer.db);
      const run1 = writer.runs.start("fixture", "ripley-pe");
      const cov1 = writer.runs.startCoverage(run1, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "drop-test" },
      });
      writer.catalog.productSnapshot(
        run1,
        "ripley-pe",
        baseProductInput({
          externalId: "drop-product",
          price: { regularCents: 10_000, offerCents: null, cardCents: null, currency: "PEN", inStock: true },
        }),
        NO_VARIANTS,
        { coverageId: cov1.coverageId },
      );
      expect(queries.searchCurrentPriceDrops().some((d) => d.externalId === "drop-product")).toBe(false);

      const run2 = writer.runs.start("fixture", "ripley-pe");
      const cov2 = writer.runs.startCoverage(run2, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "drop-test" },
      });
      const secondSnapshot = writer.catalog.productSnapshot(
        run2,
        "ripley-pe",
        baseProductInput({
          externalId: "drop-product",
          price: { regularCents: null, offerCents: 8_000, cardCents: null, currency: "PEN", inStock: true },
        }),
        NO_VARIANTS,
        { coverageId: cov2.coverageId },
      );
      const afterSighted = queries.searchCurrentPriceDrops().find((d) => d.externalId === "drop-product");
      expect(afterSighted?.effectiveCents).toBe(8_000);
      expect(afterSighted?.isPriceDrop).toBe(true);

      // A further price change with no accompanying sighting (legacy caller)
      // moves the change-log forward but leaves the latest sighting stale;
      // the product must disappear from current drops entirely.
      const legacyDrop = writer.catalog.productSnapshot(
        run2,
        "ripley-pe",
        baseProductInput({
          externalId: "drop-product",
          price: { regularCents: null, offerCents: 6_000, cardCents: null, currency: "PEN", inStock: true },
        }),
        NO_VARIANTS,
      );
      expect(legacyDrop.priceInserted).toBe(true);
      expect(queries.searchCurrentPriceDrops().some((d) => d.externalId === "drop-product")).toBe(false);

      // Sighting the SAME (already-logged) vector under real coverage catches
      // the latest sighting back up to the latest price observation.
      const run3 = writer.runs.start("fixture", "ripley-pe");
      const cov3 = writer.runs.startCoverage(run3, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: "drop-test" },
      });
      const caughtUp = writer.catalog.productSnapshot(
        run3,
        "ripley-pe",
        baseProductInput({
          externalId: "drop-product",
          price: { regularCents: null, offerCents: 6_000, cardCents: null, currency: "PEN", inStock: true },
        }),
        NO_VARIANTS,
        { coverageId: cov3.coverageId },
      );
      expect(caughtUp.priceInserted).toBe(false);
      expect(caughtUp.priceObservationId).toBe(legacyDrop.priceObservationId);
      const finalDrop = queries.searchCurrentPriceDrops().find((d) => d.externalId === "drop-product");
      expect(finalDrop?.effectiveCents).toBe(6_000);
      expect(finalDrop?.isPriceDrop).toBe(true);
      expect(finalDrop?.previousEffectiveCents).toBe(8_000);
    } finally {
      writer.close();
    }
  });
});

describe("target coverage membership rules", () => {
  test("only a complete authoritative coverage can advance consecutive misses; partial and non-authoritative coverage cannot", () => {
    const writer = openWriter();
    const stopReason = "completed" as const;
    try {
      const targetExternalId = "misses";
      const run1 = writer.runs.start("fixture", "ripley-pe");
      const cov1 = writer.runs.startCoverage(run1, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: targetExternalId },
      });
      const seen = writer.catalog.productSnapshot(
        run1,
        "ripley-pe",
        baseProductInput({ externalId: "membership-product" }),
        NO_VARIANTS,
        { coverageId: cov1.coverageId },
      );
      writer.runs.finishCoverage(cov1.coverageId, {
        status: "complete",
        authoritative: true,
        stopReason,
        requestsMade: 1,
        productsSeen: 1,
        productsRejected: 0,
        duplicatesSeen: 0,
        boundary: { complete: true },
      });

      const queries = new CatalogQueries(writer.db);
      const targetId = cov1.targetId;
      expect(queries.listTargetMemberships(targetId)[0]?.consecutiveCompleteMisses).toBe(0);

      // Complete + authoritative coverage that misses the product advances the count.
      const run2 = writer.runs.start("fixture", "ripley-pe");
      const cov2 = writer.runs.startCoverage(run2, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: targetExternalId },
      });
      const { membershipsMissed: missedComplete } = writer.runs.finishCoverage(cov2.coverageId, {
        status: "complete",
        authoritative: true,
        stopReason,
        requestsMade: 1,
        productsSeen: 0,
        productsRejected: 0,
        duplicatesSeen: 0,
        boundary: { complete: true },
      });
      expect(missedComplete).toBe(1);
      expect(queries.listTargetMemberships(targetId)[0]?.consecutiveCompleteMisses).toBe(1);

      // Partial coverage missing the product must not advance misses.
      const run3 = writer.runs.start("fixture", "ripley-pe");
      const cov3 = writer.runs.startCoverage(run3, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: targetExternalId },
      });
      const { membershipsMissed: missedPartial } = writer.runs.finishCoverage(cov3.coverageId, {
        status: "partial",
        authoritative: false,
        stopReason: "budget_exhausted",
        requestsMade: 1,
        productsSeen: 0,
        productsRejected: 0,
        duplicatesSeen: 0,
        boundary: null,
      });
      expect(missedPartial).toBe(0);
      expect(queries.listTargetMemberships(targetId)[0]?.consecutiveCompleteMisses).toBe(1);

      // A complete but non-authoritative coverage missing the product must
      // not advance misses either.
      const run4 = writer.runs.start("fixture", "ripley-pe");
      const cov4 = writer.runs.startCoverage(run4, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: targetExternalId },
      });
      const { membershipsMissed: missedNonAuthoritative } = writer.runs.finishCoverage(cov4.coverageId, {
        status: "complete",
        authoritative: false,
        stopReason,
        requestsMade: 1,
        productsSeen: 0,
        productsRejected: 0,
        duplicatesSeen: 0,
        boundary: null,
      });
      expect(missedNonAuthoritative).toBe(0);
      expect(queries.listTargetMemberships(targetId)[0]?.consecutiveCompleteMisses).toBe(1);

      // Being sighted again under a complete authoritative coverage resets the streak.
      const run5 = writer.runs.start("fixture", "ripley-pe");
      const cov5 = writer.runs.startCoverage(run5, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "category", externalId: targetExternalId },
      });
      writer.catalog.productSnapshot(
        run5,
        "ripley-pe",
        baseProductInput({ externalId: "membership-product" }),
        NO_VARIANTS,
        { coverageId: cov5.coverageId },
      );
      writer.runs.finishCoverage(cov5.coverageId, {
        status: "complete",
        authoritative: true,
        stopReason,
        requestsMade: 1,
        productsSeen: 1,
        productsRejected: 0,
        duplicatesSeen: 0,
        boundary: { complete: true },
      });
      expect(queries.listTargetMemberships(targetId)[0]?.consecutiveCompleteMisses).toBe(0);
      void seen;
    } finally {
      writer.close();
    }
  });

  test("homepage/trending coverage cannot be marked authoritative", () => {
    const writer = openWriter();
    try {
      const runId = writer.runs.start("fixture", "ripley-pe");
      const homepage = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "homepage" },
      });
      expect(() =>
        writer.runs.finishCoverage(homepage.coverageId, {
          status: "complete",
          authoritative: true,
          stopReason: "completed",
          requestsMade: 1,
          productsSeen: 5,
          productsRejected: 0,
          duplicatesSeen: 0,
          boundary: { complete: true },
        }),
      ).toThrow(/authoritative/);

      const trending = writer.runs.startCoverage(runId, {
        ...UNBOUNDED_COVERAGE,
        target: { kind: "trending" },
      });
      expect(() =>
        writer.runs.finishCoverage(trending.coverageId, {
          status: "complete",
          authoritative: true,
          stopReason: "completed",
          requestsMade: 1,
          productsSeen: 5,
          productsRejected: 0,
          duplicatesSeen: 0,
          boundary: { complete: true },
        }),
      ).toThrow(/authoritative/);
    } finally {
      writer.close();
    }
  });
});
