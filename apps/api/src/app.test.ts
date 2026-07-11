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
  const runId = writer.runs.start("fixture-products", "ripley-pe");
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
  );
  writer.runs.finish(runId, "completed", { productsSaved: 1, productsRejected: 0, requestsMade: 1, imagesDownloaded: 0 });
  writer.close();
  return snap.productId;
}

describe("api app (read-only)", () => {
  test("serves offers/products/updates/freshness and rejects writes/old job routes", async () => {
    const dbPath = tmpDbPath();
    const productId = await seed(dbPath);
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
