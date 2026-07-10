/**
 * Full pipeline integration test:
 *   registered scraper -> normalize -> product transaction -> image queue
 *   -> SQLite -> Hono API
 *
 * Exercises the real `fixture-products` scraper (which reuses the Falabella
 * normalizer) against an in-memory database and injected fakes: no network,
 * no agent-browser. A FakeClock keeps scheduler/robots/cache timing
 * deterministic and is driven forward only as far as the pending scheduler
 * gaps require.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import {
  openPersistence,
  type Persistence,
  type Page,
  type ProductSummary,
  type PriceObservation,
} from "../../src/persistence/index.ts";
import {
  CrawlPolicy,
  type HttpFetch,
  type ImageFetch,
  type RawResponse,
  type RawImageResponse,
} from "../../src/policy/crawl-policy.ts";
import { FakeClock } from "../../src/policy/clock.ts";
import { ImageWorker } from "../../src/images/image-worker.ts";
import { ScrapeRunner } from "../../src/app/scrape-runner.ts";
import { JobWorker } from "../../src/app/job-worker.ts";
import { createServer } from "../../src/server/app.ts";
import type { AppServices } from "../../src/app/services.ts";
import type { AppConfig } from "../../src/config.ts";
import { FIXTURE_LIST_URL } from "../../src/scrapers/index.ts";
import { nullLogger } from "../../src/util/logger.ts";

const HONEST_UA = "ScrapMany/1.0 (+https://operator.example/bot-info)";

// A tiny valid 1x1 PNG, decoded once and reused as the fake CDN response body.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

const FALABELLA_LIST_HTML = readFileSync(
  join(import.meta.dir, "..", "..", "src", "scrapers", "falabella-pe", "__fixtures__", "list.html"),
  "utf8",
);

const DOC_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/**
 * Drive a FakeClock forward until `work` settles. The policy's scheduler
 * occasionally needs a real clock advance to fire an internal spacing sleep
 * (e.g. the 250-750ms gap between two sequential image downloads on the same
 * host), and some steps in the chain (e.g. crypto.subtle.digest) resolve on
 * a real macrotask rather than a microtask - so each step both advances the
 * FakeClock and yields to the real event loop once. Nothing here waits on
 * real wall-clock sleep; a real-time safety bound only guards against an
 * actual deadlock.
 */
async function pumpUntilSettled<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  work.then(
    (value) => {
      settled = { ok: true, value };
    },
    (error: unknown) => {
      settled = { ok: false, error };
    },
  );
  const startedAtRealMs = Date.now();
  while (!settled) {
    if (Date.now() - startedAtRealMs > 5000) {
      throw new Error("pumpUntilSettled: FakeClock never converged (possible scheduler deadlock)");
    }
    await clock.advance(50);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
  if (!settled.ok) throw settled.error;
  return settled.value;
}

function makeHttpFetch(): HttpFetch {
  return async (url: string): Promise<RawResponse> => {
    if (url.endsWith("/robots.txt")) {
      return { status: 200, headers: {}, body: "User-agent: *\nAllow: /" };
    }
    if (url === FIXTURE_LIST_URL) {
      return { status: 200, headers: {}, body: FALABELLA_LIST_HTML };
    }
    throw new Error(`unexpected httpFetch url in test: ${url}`);
  };
}

function makeImageFetch(): ImageFetch {
  return async (url: string): Promise<RawImageResponse> => {
    const host = new URL(url).hostname;
    if (host !== "media.falabella.com.pe") {
      throw new Error(`unexpected imageFetch host in test: ${host}`);
    }
    return { status: 200, headers: { "content-type": "image/png" }, bytes: PNG_BYTES };
  };
}

function shaFromImageUrl(imageUrl: string | null): string {
  if (!imageUrl) throw new Error("expected a product imageUrl");
  const match = /^\/images\/([a-f0-9]{64})$/.exec(imageUrl);
  if (!match?.[1]) throw new Error(`imageUrl does not look like a content-addressed path: ${imageUrl}`);
  return match[1];
}

/** Parse a Hono test Response body with the DTO shape the route contract promises. */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("pipeline: registered scraper -> normalize -> product transaction -> image queue -> SQLite -> Hono API", () => {
  let storageDir: string;
  let persistence: Persistence;
  let clock: FakeClock;
  let worker: JobWorker;
  let server: Hono;

  // Populated by the first run, reused by the re-run assertions.
  let productId: number;
  let imageSha: string;

  beforeAll(() => {
    storageDir = mkdtempSync(join(tmpdir(), "scrap-many-pipeline-"));
    persistence = openPersistence(":memory:", { migrate: true });
    clock = new FakeClock(0);

    const policy = new CrawlPolicy({
      userAgent: HONEST_UA,
      httpFetch: makeHttpFetch(),
      imageFetch: makeImageFetch(),
      clock,
      random: () => 0.5,
    });
    const images = new ImageWorker(policy, persistence.catalog, storageDir, nullLogger);
    const runner = new ScrapeRunner({
      policy,
      catalog: persistence.catalog,
      runs: persistence.runs,
      images,
      clock,
      logger: nullLogger,
    });
    worker = new JobWorker(persistence.jobs, runner, { clock, logger: nullLogger });

    const config: AppConfig = {
      dbPath: ":memory:",
      storageDir,
      discoveryDir: join(storageDir, "discovery"),
      userAgent: HONEST_UA,
      apiKey: undefined,
      host: "127.0.0.1",
      port: 3000,
      agentBrowserBin: "agent-browser",
      agentBrowserTimeoutMs: 25000,
      workerIdleTimeoutMs: 20000,
    };
    const app: AppServices = {
      config,
      persistence,
      logger: nullLogger,
      close: () => persistence.close(),
    };
    server = createServer(app);
  });

  afterAll(() => {
    persistence.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  test(
    "first run: job goes queued -> running -> completed and the catalog/search/image API reflects it",
    async () => {
      const enqueued = persistence.jobs.enqueue({
        scraperId: "fixture-products",
        maxRequests: 10,
        maxDurationMs: 30000,
      });
      expect(persistence.jobs.get(enqueued.id)?.status).toBe("queued");

      // JobWorker.drain() claims the job synchronously (BEGIN IMMEDIATE, no
      // await before it) before its first genuine suspension point, so the
      // status flip to "running" is observable before we drive the clock.
      const drainPromise = worker.drain();
      expect(persistence.jobs.get(enqueued.id)?.status).toBe("running");

      const ranCount = await pumpUntilSettled(clock, drainPromise);
      expect(ranCount).toBe(1);

      const finishedJob = persistence.jobs.get(enqueued.id);
      expect(finishedJob?.status).toBe("completed");
      expect(finishedJob?.products_saved).toBe(2);
      expect(finishedJob?.products_rejected).toBe(0);

      // Product persisted: the list route surfaces exactly the two priced
      // fixture entries (the sku/price-less third entry never reaches save).
      const listRes = await server.request("/products");
      expect(listRes.status).toBe(200);
      const listBody = await readJson<Page<ProductSummary>>(listRes);
      expect(listBody.data).toHaveLength(2);

      const fridge = listBody.data.find((p) => p.externalId === "20936199");
      if (!fridge) throw new Error("expected the fridge fixture product to be persisted");
      expect(fridge.name).toBe("Refrigeradora No Frost 300L");
      expect(fridge.brand).toBe("Mabe");
      expect(fridge.regularCents).toBe(199900);
      expect(fridge.offerCents).toBe(149900);
      expect(fridge.cardCents).toBe(139900);
      expect(fridge.currency).toBe("PEN");
      productId = fridge.id;
      imageSha = shaFromImageUrl(fridge.imageUrl);

      // Latest price present.
      const priceRes = await server.request(`/products/${productId}/prices`);
      expect(priceRes.status).toBe(200);
      const priceBody = await readJson<{ data: PriceObservation[] }>(priceRes);
      expect(priceBody.data).toHaveLength(1);
      expect(priceBody.data[0]?.regularCents).toBe(199900);
      expect(priceBody.data[0]?.offerCents).toBe(149900);
      expect(priceBody.data[0]?.cardCents).toBe(139900);

      // FTS search surfaces the product by name.
      const searchRes = await server.request("/search?q=Refrigeradora");
      expect(searchRes.status).toBe(200);
      const searchBody = await readJson<{ data: ProductSummary[] }>(searchRes);
      expect(searchBody.data.some((p) => p.id === productId)).toBe(true);

      // The image is archived and served content-addressed by its own hash.
      const imageRes = await server.request(`/images/${imageSha}`);
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get("etag")).toBe(`"${imageSha}"`);
      expect(imageRes.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await imageRes.arrayBuffer());
      expect(Array.from(bytes)).toEqual(Array.from(PNG_BYTES));

      // Two distinct product image URLs canonicalize/download to identical
      // bytes, so they dedupe to a single stored image row.
      expect(persistence.queries.stats().images).toBe(1);
    },
    10000,
  );

  test(
    "re-run past the freshness window: same product identity, change-gated price, deduped image",
    async () => {
      // Cross the 24h document freshness floor so the second run performs a
      // genuine re-fetch/re-normalize instead of short-circuiting on the
      // policy's conditional cache.
      await clock.advance(DOC_FRESHNESS_MS + 60 * 60 * 1000);

      const enqueued = persistence.jobs.enqueue({
        scraperId: "fixture-products",
        maxRequests: 10,
        maxDurationMs: 30000,
      });
      const drainPromise = worker.drain();
      const ranCount = await pumpUntilSettled(clock, drainPromise);
      expect(ranCount).toBe(1);
      expect(persistence.jobs.get(enqueued.id)?.status).toBe("completed");

      // Still exactly the same two products - no duplicates created for an
      // externalId that already exists.
      const listRes = await server.request("/products");
      const listBody = await readJson<Page<ProductSummary>>(listRes);
      expect(listBody.data).toHaveLength(2);
      const fridge = listBody.data.find((p) => p.externalId === "20936199");
      if (!fridge) throw new Error("expected the fridge fixture product to still be persisted");
      expect(fridge.id).toBe(productId);

      // Change-gated pricing: identical price on recrawl inserts no new row.
      const priceRes = await server.request(`/products/${productId}/prices`);
      const priceBody = await readJson<{ data: PriceObservation[] }>(priceRes);
      expect(priceBody.data).toHaveLength(1);

      // Image dedup by sha256 holds across recrawls too - no re-download,
      // still exactly one stored image.
      expect(persistence.queries.stats().images).toBe(1);
      expect(shaFromImageUrl(fridge.imageUrl)).toBe(imageSha);
    },
    10000,
  );
});
