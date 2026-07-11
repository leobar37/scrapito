import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateVariants } from "@scrapito/contracts";
import { openCatalogWriter } from "./write/index.ts";
import { openCatalogReader } from "./read/index.ts";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scrapito-catalog-"));
  return join(dir, "test.sqlite");
}

describe("catalog write+read", () => {
  test("migrates, snapshots a product with variants, and is queryable read-only", () => {
    const dbPath = tmpDbPath();
    const writer = openCatalogWriter(dbPath, { migrate: true });
    try {
      const runId = writer.runs.start("fixture-products", "ripley-pe");

      const rawVariants = [
        { externalId: "v1", sku: "SKU1", name: "Rojo", colorName: "Rojo", colorHex: "#FF0000", size: "M", inStock: true, attributes: {}, images: [] },
        { externalId: "v1", sku: "DUP", name: null, colorName: null, colorHex: null, size: null, inStock: true, attributes: {}, images: [] },
        { externalId: "v2", sku: "SKU2", name: "Azul", colorName: "Azul", colorHex: "not-a-hex", size: "L", inStock: true, attributes: {}, images: [] },
      ];
      const { variants, warnings } = validateVariants(rawVariants);
      expect(variants.length).toBe(1);
      expect(warnings.length).toBe(2);

      const result = writer.catalog.productSnapshot(
        runId,
        "ripley-pe",
        {
          store: "ripley-pe",
          externalId: "p1",
          canonicalUrl: "https://simple.ripley.com.pe/p1",
          name: "Test Product",
          sponsored: false,
          attributes: {},
          categories: [],
          images: [],
          price: { regularCents: 10000, offerCents: 7500, cardCents: null, currency: "PEN", inStock: true },
          variants: [],
          variantsObserved: true,
        },
        variants,
      );
      expect(result.created).toBe(true);
      expect(result.variantsUpserted).toBe(1);

      writer.runs.finish(runId, "completed", {
        productsSaved: 1,
        productsRejected: 0,
        requestsMade: 1,
        imagesDownloaded: 0,
      });
      writer.close();

      const reader = openCatalogReader(dbPath);
      try {
        const detail = reader.queries.getProduct(result.productId);
        expect(detail).not.toBeNull();
        expect(detail?.variants.length).toBe(1);
        expect(detail?.variants[0]?.externalId).toBe("v1");

        const offers = reader.queries.searchOffers({
          inStock: true,
          limit: 24,
          sort: "discount_desc",
        } as never);
        expect(offers.data.length).toBe(1);
        expect(offers.data[0]?.quality).toBe("verified_discount");
        expect(offers.data[0]?.discountBps).toBe(2500);

        // Direct write attempt through the readonly reader connection must fail.
        expect(() => reader.db.exec("INSERT INTO stores (id, name, base_url) VALUES ('x','x','x')")).toThrow();

        const updates = reader.queries.listUpdates({ limit: 10 });
        expect(updates.data.length).toBe(1);
        expect(updates.data[0]?.status).toBe("completed");

        const freshness = reader.queries.getFreshness();
        const ripley = freshness.find((f) => f.storeId === "ripley-pe");
        expect(ripley?.lastSuccessfulAt).not.toBeNull();
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });
    }
  });

  test("second migration run is idempotent", () => {
    const dbPath = tmpDbPath();
    const w1 = openCatalogWriter(dbPath, { migrate: true });
    w1.close();
    const w2 = openCatalogWriter(dbPath, { migrate: true, requireMigrated: true });
    w2.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
  });
});
