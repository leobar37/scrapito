import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogWriter } from "@scrapito/catalog/write";
import { openCatalogReader } from "@scrapito/catalog/read";
import { createServer } from "./app.ts";
import type { ApiConfig } from "./config.ts";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scrapito-api-"));
  return join(dir, "test.sqlite");
}

function baseConfig(dbPath: string): ApiConfig {
  return { dbPath, storageDir: "/tmp/scrapito-storage", host: "127.0.0.1", port: 0, publicReads: false, webOrigins: ["https://web.example"] };
}

async function seed(dbPath: string) {
  const writer = openCatalogWriter(dbPath, { migrate: true });
  const runId = writer.runs.start("fixture-products", "ripley-pe", { invocationId: "api-handoff" });
  const { coverageId } = writer.runs.startCoverage(runId, {
    target: { kind: "category", externalId: "laptops" },
    maxRequests: 5,
    maxDurationMs: 1000,
    requestedPages: [1],
  });
  const snap = writer.catalog.productSnapshot(
    runId,
    "ripley-pe",
    {
      store: "ripley-pe",
      externalId: "p1",
      canonicalUrl: "https://simple.ripley.com.pe/p1",
      name: "Laptop HP 15",
      brand: "HP",
      sponsored: false,
      attributes: {},
      categories: [],
      images: [],
      price: { regularCents: 10000, offerCents: 7500, cardCents: null, currency: "PEN", inStock: true },
      variants: [],
      variantsObserved: false,
    },
    [],
    { coverageId },
  );
  writer.runs.finishCoverage(coverageId, {
    status: "complete",
    authoritative: true,
    stopReason: "completed",
    requestsMade: 1,
    productsSeen: 1,
    duplicatesSeen: 0,
    productsRejected: 0,
    boundary: { completedPages: [1] },
  });
  writer.runs.finish(runId, "completed", { productsSaved: 1, productsRejected: 0, requestsMade: 1, imagesDownloaded: 0 });
  const legacyRunId = writer.runs.start("legacy", "ripley-pe");
  const legacy = writer.runs.startCoverage(legacyRunId, {
    target: { kind: "category", externalId: "legacy" },
    maxRequests: null,
    maxDurationMs: null,
    requestedPages: null,
  });
  writer.close();
  return { productId: snap.productId, coverageId, legacyCoverageId: legacy.coverageId };
}

describe("api app (read-only)", () => {
  test("serves offers/products/updates/freshness and rejects writes/old job routes", async () => {
    const dbPath = tmpDbPath();
    const { productId, coverageId, legacyCoverageId } = await seed(dbPath);
    const reader = openCatalogReader(dbPath);
    const config = baseConfig(dbPath);
    const app = createServer(reader, config);

    try {
      const health = await app.request("/health");
      expect(health.status).toBe(200);

      const offers = await app.request("/offers?sort=discount_desc");
      expect(offers.status).toBe(200);
      const offersBody = (await offers.json()) as { data: unknown[]; facets: unknown };
      expect(offersBody.data.length).toBe(1);

      const handoff = await app.request(`/coverages/${coverageId}/offers?limit=1`);
      expect(handoff.status).toBe(200);
      const handoffBody = (await handoff.json()) as {
        invocationId: string;
        coverage: { coverageId: number };
        data: Array<{ productId: number; evidence: { coverageId: number } }>;
      };
      expect(handoffBody.invocationId).toBe("api-handoff");
      expect(handoffBody.coverage.coverageId).toBe(coverageId);
      expect(handoffBody.data).toEqual([
        expect.objectContaining({ productId, evidence: expect.objectContaining({ coverageId }) }),
      ]);

      for (const path of [
        "/coverages/nope/offers",
        `/coverages/${coverageId}/offers?limit=0`,
        `/coverages/${coverageId}/offers?cursor=malformed`,
      ]) {
        const bad = await app.request(path);
        expect(bad.status).toBe(400);
      }
      expect((await app.request("/coverages/999999/offers")).status).toBe(404);
      expect((await app.request(`/coverages/${legacyCoverageId}/offers`)).status).toBe(404);
      expect((await app.request(`/coverages/${coverageId}/offers`, { method: "POST" })).status).toBe(404);

      const product = await app.request(`/products/${productId}`);
      expect(product.status).toBe(200);
      const productBody = (await product.json()) as { data: { variants: unknown[] } };
      expect(Array.isArray(productBody.data.variants)).toBe(true);

      const updates = await app.request("/updates");
      expect(updates.status).toBe(200);

      const freshness = await app.request("/freshness");
      expect(freshness.status).toBe(200);

      // Old job/mutation routes must be entirely gone -> 404.
      for (const path of ["/jobs", "/jobs/1", "/scrapers", "/jobs/scrape"]) {
        const res = await app.request(path, { method: path === "/jobs/scrape" ? "POST" : "GET" });
        expect(res.status).toBe(404);
      }

      // CORS: configured origin gets exact allow-origin; other origins are forbidden.
      const allowed = await app.request("/offers", { headers: { Origin: "https://web.example" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://web.example");
      const denied = await app.request("/offers", { headers: { Origin: "https://evil.example" } });
      expect(denied.status).toBe(403);

      // Direct write through the readonly reader connection fails.
      expect(() => reader.db.exec("DELETE FROM products")).toThrow();
    } finally {
      reader.close();
      rmSync(dbPath, { force: true });
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });
    }
  });
});
