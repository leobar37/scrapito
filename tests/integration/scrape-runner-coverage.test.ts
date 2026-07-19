/**
 * ScrapeRunner coverage wiring: focused integration tests against a temp
 * SQLite catalog (never data/scrap.sqlite). Exercises `run()`'s coverage
 * plumbing end to end — options.target -> RunStore.startCoverage/
 * finishCoverage -> CatalogStore.productSnapshot sighting inserts — without
 * duplicating CatalogStore/RunStore's own unit-level tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { openCatalogWriter, type TargetCoverageRow, type ProductSightingRow } from "@scrapito/catalog/write";
import { CatalogQueries } from "@scrapito/catalog/read";
import { CrawlPolicy, type HttpFetch } from "../../apps/ingest/src/policy/crawl-policy.ts";
import { FakeClock } from "../../apps/ingest/src/policy/clock.ts";
import { ScrapeRunner } from "../../apps/ingest/src/app/scrape-runner.ts";
import { defineScraper } from "../../apps/ingest/src/scrapers/define-scraper.ts";

const USER_AGENT = "ScrapMany/1.0 (+https://operator.example/bot-info)";
const STORE_HOST = "https://www.promart.pe";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scrapito-runner-coverage-"));
  return join(dir, "test.sqlite");
}

function throwingHttpFetch(): HttpFetch {
  return async (url) => {
    throw new Error(`network access is not allowed in this test: ${url}`);
  };
}

function buildPolicy(httpFetch: HttpFetch = throwingHttpFetch()): CrawlPolicy {
  return new CrawlPolicy({
    userAgent: USER_AGENT,
    httpFetch,
    clock: new FakeClock(0),
    random: () => 0.5,
  });
}

/** Saves two distinct products, no network required. */
const twoProductScraper = defineScraper({
  id: "coverage-two-products",
  store: "promart-pe",
  version: 1,
  match: [STORE_HOST + "/"],
  paramsSchema: z.object({}).passthrough(),
  defaults: { downloadImages: false },
  async scrape(ctx) {
    for (const sku of ["sku-a", "sku-b"]) {
      ctx.save.productSnapshot({
        store: "promart-pe",
        externalId: sku,
        canonicalUrl: `${STORE_HOST}/${sku}`,
        name: `Product ${sku}`,
        price: { regularCents: 10_000 },
      });
    }
  },
});

/** Saves one product, then exhausts the request budget mid-run via ctx.http.fetch. */
const budgetExhaustingScraper = defineScraper({
  id: "coverage-budget-exhausting",
  store: "promart-pe",
  version: 1,
  match: [STORE_HOST + "/"],
  paramsSchema: z.object({}).passthrough(),
  defaults: { downloadImages: false },
  async scrape(ctx) {
    ctx.save.productSnapshot({
      store: "promart-pe",
      externalId: "sku-partial",
      canonicalUrl: `${STORE_HOST}/sku-partial`,
      name: "Partial product",
      price: { regularCents: 5_000 },
    });
    // Budget is 1 request; this second fetch spends it and the third throws.
    await ctx.http.fetch(`${STORE_HOST}/page-1`, { class: "document" });
    await ctx.http.fetch(`${STORE_HOST}/page-2`, { class: "document" });
  },
});

/** Legacy-shaped scraper: same save path, run without a `target` option. */
const legacyScraper = defineScraper({
  id: "coverage-legacy",
  store: "promart-pe",
  version: 1,
  match: [STORE_HOST + "/"],
  paramsSchema: z.object({}).passthrough(),
  defaults: { downloadImages: false },
  async scrape(ctx) {
    ctx.save.productSnapshot({
      store: "promart-pe",
      externalId: "sku-legacy",
      canonicalUrl: `${STORE_HOST}/sku-legacy`,
      name: "Legacy product",
      price: { regularCents: 7_500 },
    });
  },
});

function alwaysOkFetch(): HttpFetch {
  return async () => ({ status: 200, headers: {}, body: "ok" });
}

describe("ScrapeRunner coverage wiring", () => {
  test("a target run coverageId resolves to exactly its evidence-backed sighted offers", async () => {
    const dbPath = tmpDbPath();
    const writer = openCatalogWriter(dbPath, { migrate: true });
    try {
      const runner = new ScrapeRunner({
        policy: buildPolicy(),
        catalog: writer.catalog,
        runs: writer.runs,
        clock: new FakeClock(0),
      });
      const outcome = await runner.run(
        twoProductScraper,
        {},
        {
          maxRequests: 10,
          maxDurationMs: 10_000,
          target: { kind: "category", externalId: "electro" },
          provenance: {
            invocationId: "integration-target-run",
            strategy: "category",
            capability: "acquire",
          },
        },
      );

      expect(outcome.status).toBe("completed");
      expect(outcome.productsSaved).toBe(2);
      expect(outcome.coverageId).not.toBeNull();

      const coverage = writer.db
        .query<TargetCoverageRow, [number]>("SELECT * FROM target_coverages WHERE id=?")
        .get(outcome.coverageId as number);
      expect(coverage?.status).toBe("complete");
      expect(coverage?.products_seen).toBe(2);

      const sightings = writer.db
        .query<ProductSightingRow, [number]>("SELECT * FROM product_sightings WHERE coverage_id=?")
        .all(outcome.coverageId as number);
      expect(sightings).toHaveLength(2);
      const productIds = new Set(sightings.map((s) => s.product_id));
      expect(productIds.size).toBe(2);
      for (const sighting of sightings) {
        expect(sighting.price_observation_id).toBeGreaterThan(0);
      }

      const handoff = new CatalogQueries(writer.db).getCoverageOfferHandoff(outcome.coverageId as number);
      expect(handoff.invocationId).toBe("integration-target-run");
      expect(handoff.coverage.coverageId).toBe(outcome.coverageId);
      expect(handoff.data.map((offer) => offer.productId).sort()).toEqual([...productIds].sort());
      expect(handoff.data.every((offer) => offer.evidence.coverageId === outcome.coverageId)).toBe(true);
      expect(handoff.data.map((offer) => offer.price.observationId).sort()).toEqual(
        sightings.map((sighting) => sighting.price_observation_id).sort(),
      );
    } finally {
      writer.close();
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  test("saving the same product+coverage vector again reuses the current price observation id", async () => {
    const dbPath = tmpDbPath();
    const writer = openCatalogWriter(dbPath, { migrate: true });
    try {
      const runner = new ScrapeRunner({
        policy: buildPolicy(),
        catalog: writer.catalog,
        runs: writer.runs,
        clock: new FakeClock(0),
      });
      // Re-run the same two-product scrape under a fresh coverage of the SAME
      // target identity: the target/product rows are reused, and repeating
      // the identical price vector must not fabricate a new price row.
      const first = await runner.run(
        twoProductScraper,
        {},
        { maxRequests: 10, maxDurationMs: 10_000, target: { kind: "category", externalId: "electro" } },
      );
      const second = await runner.run(
        twoProductScraper,
        {},
        { maxRequests: 10, maxDurationMs: 10_000, target: { kind: "category", externalId: "electro" } },
      );
      expect(second.coverageId).not.toBe(first.coverageId);

      const firstSightings = writer.db
        .query<ProductSightingRow, [number]>("SELECT * FROM product_sightings WHERE coverage_id=? ORDER BY product_id")
        .all(first.coverageId as number);
      const secondSightings = writer.db
        .query<ProductSightingRow, [number]>("SELECT * FROM product_sightings WHERE coverage_id=? ORDER BY product_id")
        .all(second.coverageId as number);
      expect(secondSightings).toHaveLength(2);
      expect(secondSightings.map((s) => s.price_observation_id)).toEqual(
        firstSightings.map((s) => s.price_observation_id),
      );
    } finally {
      writer.close();
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  test("a partial (budget-exhausted) run persists coverage as partial and non-authoritative, even when authoritative was requested", async () => {
    const dbPath = tmpDbPath();
    const writer = openCatalogWriter(dbPath, { migrate: true });
    try {
      const runner = new ScrapeRunner({
        policy: buildPolicy(alwaysOkFetch()),
        catalog: writer.catalog,
        runs: writer.runs,
        clock: new FakeClock(0),
      });
      const outcome = await runner.run(
        budgetExhaustingScraper,
        {},
        {
          maxRequests: 1,
          maxDurationMs: 10_000,
          target: { kind: "category", externalId: "electro-partial" },
          authoritativeCoverage: true,
          coverageBoundary: { pages: 1 },
        },
      );

      expect(outcome.status).toBe("partial");
      expect(outcome.coverageId).not.toBeNull();

      const coverage = writer.db
        .query<TargetCoverageRow, [number]>("SELECT * FROM target_coverages WHERE id=?")
        .get(outcome.coverageId as number);
      expect(coverage?.status).toBe("partial");
      expect(coverage?.authoritative).toBe(0);
      expect(coverage?.stop_reason).toBe("budget_exhausted");

      // The product saved before the budget ran out still gets a sighting —
      // partial coverage only forfeits "complete"/authoritative status, not
      // the observations already made.
      const sightings = writer.db
        .query<ProductSightingRow, [number]>("SELECT * FROM product_sightings WHERE coverage_id=?")
        .all(outcome.coverageId as number);
      expect(sightings).toHaveLength(1);
    } finally {
      writer.close();
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  test("a legacy caller that omits target stays compatible: run succeeds, no coverage or sighting row is created", async () => {
    const dbPath = tmpDbPath();
    const writer = openCatalogWriter(dbPath, { migrate: true });
    try {
      const runner = new ScrapeRunner({
        policy: buildPolicy(),
        catalog: writer.catalog,
        runs: writer.runs,
        clock: new FakeClock(0),
      });
      const outcome = await runner.run(legacyScraper, {}, { maxRequests: 5, maxDurationMs: 10_000 });

      expect(outcome.status).toBe("completed");
      expect(outcome.productsSaved).toBe(1);
      expect(outcome.coverageId).toBeNull();

      const coverageCount = writer.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM target_coverages")
        .get();
      const sightingCount = writer.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM product_sightings")
        .get();
      expect(coverageCount?.n).toBe(0);
      expect(sightingCount?.n).toBe(0);
    } finally {
      writer.close();
      rmSync(dbPath, { recursive: true, force: true });
    }
  });
});

