/**
 * Hono HTTP server over the shared application services. Read routes expose only
 * the local catalog and stay unauthenticated; every mutating route requires
 * `Authorization: Bearer ${SCRAP_API_KEY}`. The server accepts ONLY a registered
 * scraper id plus that scraper's validated params — never source, paths, or URLs.
 */
import { Hono } from "hono";
import { join } from "node:path";
import { z } from "zod";
import type { AppServices } from "../app/services.ts";
import { decodeCursor } from "../persistence/cursor.ts";
import { StoreIdSchema } from "../domain/ids.ts";
import { getScraper, listScrapers } from "../scrapers/registry.ts";
import { ScrapError } from "../domain/errors.ts";

const JobScrapeBody = z.object({
  scraperId: z.string().min(1),
  category: z.string().min(1).optional(),
  pages: z
    .union([
      z.number().int().positive(),
      z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
      z.array(z.number().int().positive()),
    ])
    .optional(),
  downloadImages: z.boolean().optional(),
  maxRequests: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
});

function parseLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : 20;
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}

export function createServer(app: AppServices): Hono {
  const api = new Hono();
  const { queries, jobs } = { queries: app.persistence.queries, jobs: app.persistence.jobs };
  const apiKey = app.config.apiKey;

  const requireAuth = (authHeader: string | undefined): boolean => {
    if (!apiKey) return false;
    return authHeader === `Bearer ${apiKey}`;
  };

  api.get("/health", (c) => c.json({ data: { status: "ok" } }));

  api.get("/stores", (c) => c.json({ data: queries.listStores() }));

  api.get("/categories", (c) => {
    const store = c.req.query("store");
    const parsed = store ? StoreIdSchema.safeParse(store) : null;
    if (store && parsed && !parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid store" } }, 400);
    }
    // Categories are returned via products' links; expose empty list placeholder.
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
    const file = Bun.file(join(app.config.storageDir, meta.relativePath));
    if (!(await file.exists())) {
      return c.json({ error: { code: "NOT_FOUND", message: "image bytes missing" } }, 404);
    }
    c.header("Content-Type", meta.mime);
    c.header("ETag", `"${sha}"`);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(await file.arrayBuffer());
  });

  api.get("/search", (c) => {
    const q = c.req.query("q");
    if (!q || q.trim().length === 0) {
      return c.json({ error: { code: "BAD_REQUEST", message: "q is required" } }, 400);
    }
    return c.json({ data: queries.search(q, { limit: parseLimit(c.req.query("limit")) }) });
  });

  api.get("/stats", (c) => c.json({ data: queries.stats() }));

  api.get("/scrapers", (c) =>
    c.json({
      data: listScrapers().map((s) => ({
        id: s.id,
        store: s.store,
        version: s.version,
        defaults: s.defaults,
      })),
    }),
  );

  api.post("/jobs/scrape", async (c) => {
    if (!requireAuth(c.req.header("authorization"))) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid API key" } }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid JSON" } }, 400);
    }
    const parsed = JobScrapeBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "invalid job", details: parsed.error.issues } },
        400,
      );
    }
    const scraper = getScraper(parsed.data.scraperId);
    if (!scraper) {
      return c.json({ error: { code: "UNKNOWN_SCRAPER", message: "unknown scraper id" } }, 400);
    }
    const paramCheck = scraper.paramsSchema.safeParse({
      category: parsed.data.category,
      pages: parsed.data.pages,
    });
    if (!paramCheck.success) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "invalid scraper params", details: paramCheck.error.issues } },
        400,
      );
    }
    const result = jobs.enqueue({
      scraperId: parsed.data.scraperId,
      category: parsed.data.category,
      pages: parsed.data.pages,
      downloadImages: parsed.data.downloadImages,
      maxRequests: parsed.data.maxRequests,
      maxDurationMs: parsed.data.maxDurationMs,
    });
    return c.json({ jobId: result.id, status: "queued" }, 202);
  });

  api.get("/jobs", (c) => {
    const cursor = c.req.query("cursor");
    let afterId = 0;
    if (cursor) {
      try {
        afterId = decodeCursor(cursor);
      } catch {
        return c.json({ error: { code: "INVALID_CURSOR", message: "malformed cursor" } }, 400);
      }
    }
    return c.json(queries.listJobs({ afterId, limit: parseLimit(c.req.query("limit")) }));
  });

  api.get("/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid id" } }, 400);
    }
    const job = queries.getJob(id);
    if (!job) return c.json({ error: { code: "NOT_FOUND", message: "job not found" } }, 404);
    return c.json({ data: job });
  });

  api.post("/jobs/:id/cancel", (c) => {
    if (!requireAuth(c.req.header("authorization"))) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid API key" } }, 401);
    }
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid id" } }, 400);
    }
    const ok = jobs.cancel(id);
    if (!ok) return c.json({ error: { code: "CONFLICT", message: "job not cancellable" } }, 409);
    return c.json({ data: { id, status: "cancelled" } });
  });

  api.onError((err, c) => {
    if (err instanceof ScrapError) {
      return c.json({ error: { code: err.code, message: err.message } }, 400);
    }
    return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
  });

  return api;
}
