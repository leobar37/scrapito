/**
 * Read-only Hono HTTP API. Opens the catalog through @scrapito/catalog/read
 * ONLY — no writer, no ingestion, no browser, no scraper registry. It cannot
 * enqueue, cancel, or execute scraping work; that is `scrap-ingest run`.
 */
import { Hono } from "hono";
import { join } from "node:path";
import {
  StoreIdSchema,
  ScrapError,
  decodeOfferSearchParams,
  toFtsMatchQuery,
} from "@scrapito/contracts";
import type { CatalogReader } from "@scrapito/catalog/read";
import { decodeCursor } from "@scrapito/contracts";
import type { ApiConfig } from "./config.ts";
import { strictCors } from "./cors.ts";

function parseLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : 20;
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}

export function createServer(reader: CatalogReader, config: ApiConfig): Hono {
  const api = new Hono();
  const { queries } = reader;

  api.use("*", strictCors(config.webOrigins));

  api.get("/health", (c) => c.json({ data: { status: "ok" } }));

  api.get("/stores", (c) => c.json({ data: queries.listStores() }));

  api.get("/categories", (c) => {
    const store = c.req.query("store");
    const parsed = store ? StoreIdSchema.safeParse(store) : null;
    if (store && parsed && !parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid store" } }, 400);
    }
    return c.json({ data: [] });
  });

  api.get("/products", (c) => {
    const store = c.req.query("store");
    const parsedStore = store ? StoreIdSchema.safeParse(store) : null;
    if (store && parsedStore && !parsedStore.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid store" } }, 400);
    }
    const cursor = c.req.query("cursor");
    let afterId = 0;
    if (cursor) {
      try {
        afterId = decodeCursor(cursor);
      } catch {
        return c.json({ error: { code: "INVALID_CURSOR", message: "malformed cursor" } }, 400);
      }
    }
    const page = queries.listProducts({
      store: parsedStore && parsedStore.success ? parsedStore.data : undefined,
      afterId,
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json(page);
  });

  api.get("/products/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid id" } }, 400);
    }
    const product = queries.getProduct(id);
    if (!product) return c.json({ error: { code: "NOT_FOUND", message: "product not found" } }, 404);
    return c.json({ data: product });
  });

  api.get("/products/:id/prices", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid id" } }, 400);
    }
    return c.json({ data: queries.getPrices(id) });
  });

  api.get("/images/:sha256", async (c) => {
    const sha = c.req.param("sha256");
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid sha256" } }, 400);
    }
    const meta = queries.getImageMeta(sha);
    if (!meta) return c.json({ error: { code: "NOT_FOUND", message: "image not found" } }, 404);
    const file = Bun.file(join(config.storageDir, meta.relativePath));
    if (!(await file.exists())) {
      return c.json({ error: { code: "NOT_FOUND", message: "image bytes missing" } }, 404);
    }
    c.header("Content-Type", meta.mime);
    c.header("ETag", `"${sha}"`);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(await file.arrayBuffer());
  });

  // Deprecated for one release: delegates to the same offer search engine.
  api.get("/search", (c) => {
    const q = c.req.query("q");
    if (!q || q.trim().length === 0) {
      return c.json({ error: { code: "BAD_REQUEST", message: "q is required" } }, 400);
    }
    try {
      toFtsMatchQuery(q);
    } catch (err) {
      return c.json({ error: { code: "BAD_REQUEST", message: (err as Error).message } }, 400);
    }
    return c.json({ data: queries.search(q, { limit: parseLimit(c.req.query("limit")) }) });
  });

  api.get("/offers", (c) => {
    let input: ReturnType<typeof decodeOfferSearchParams>;
    try {
      input = decodeOfferSearchParams(new URL(c.req.url).searchParams);
    } catch (err) {
      if (err instanceof ScrapError) {
        return c.json({ error: { code: err.code, message: err.message, details: err.details } }, 400);
      }
      throw err;
    }
    try {
      const page = queries.searchOffers(input);
      return c.json(page);
    } catch (err) {
      if (err instanceof ScrapError) {
        return c.json({ error: { code: err.code, message: err.message, details: err.details } }, 400);
      }
      throw err;
    }
  });

  api.get("/offers/:productId/history", (c) => {
    const id = Number(c.req.param("productId"));
    if (!Number.isInteger(id)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid productId" } }, 400);
    }
    return c.json({ data: queries.getOfferHistory(id) });
  });

  api.get("/updates", (c) => {
    const store = c.req.query("store");
    const parsedStore = store ? StoreIdSchema.safeParse(store) : null;
    if (store && parsedStore && !parsedStore.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid store" } }, 400);
    }
    const cursor = c.req.query("cursor");
    let beforeId = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try {
        beforeId = decodeCursor(cursor);
      } catch {
        return c.json({ error: { code: "INVALID_CURSOR", message: "malformed cursor" } }, 400);
      }
    }
    const page = queries.listUpdates({
      store: parsedStore && parsedStore.success ? parsedStore.data : undefined,
      beforeId,
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json(page);
  });

  api.get("/freshness", (c) => c.json({ data: queries.getFreshness() }));

  api.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "route not found" } }, 404));

  api.onError((err, c) => {
    if (err instanceof ScrapError) {
      return c.json({ error: { code: err.code, message: err.message } }, 400);
    }
    return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
  });

  return api;
}
