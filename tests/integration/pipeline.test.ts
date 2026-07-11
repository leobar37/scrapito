/**
 * Full cross-app pipeline integration test:
 *   registered scraper -> normalize -> synchronous ingestion run
 *   -> SQLite (writer) -> SQLite (reader, same file) -> Hono API
 *
 * Exercises the real `fixture-products` scraper (which reuses the Falabella
 * normalizer) against a real (temp-file, WAL) database and injected fakes: no
 * network, no agent-browser, no job queue. The writer and reader connections
 * are separate — exactly the production topology of `apps/ingest` (writer)
 * and `apps/api` (readonly reader) composing over one SQLite file. A
 * FakeClock keeps scheduler/robots/cache timing deterministic.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { openCatalogWriter, type CatalogWriter } from "@scrapito/catalog/write";
import { openCatalogReader, type CatalogReader } from "@scrapito/catalog/read";
import type { Page, PriceObservation, ProductSummary } from "@scrapito/contracts";
import {
  CrawlPolicy,
  type HttpFetch,
  type ImageFetch,
  type RawImageResponse,
  type RawResponse,
} from "../../apps/ingest/src/policy/crawl-policy.ts";
import { FakeClock } from "../../apps/ingest/src/policy/clock.ts";
import { ImageWorker } from "../../apps/ingest/src/images/image-worker.ts";
import { ScrapeRunner } from "../../apps/ingest/src/app/scrape-runner.ts";
import { getScraper } from "../../apps/ingest/src/scrapers/registry.ts";
import { FIXTURE_LIST_URL } from "../../apps/ingest/src/scrapers/index.ts";
import { nullLogger } from "../../apps/ingest/src/util/logger.ts";
import { createServer } from "../../apps/api/src/app.ts";
import type { ApiConfig } from "../../apps/api/src/config.ts";

const HONEST_UA = "ScrapMany/1.0 (+https://operator.example/bot-info)";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

const FALABELLA_LIST_HTML = readFileSync(
  join(import.meta.dir, "..", "..", "apps", "ingest", "src", "scrapers", "falabella-pe", "__fixtures__", "list.html"),
  "utf8",
);

const DOC_FRESHNESS_MS = 24 * 60 * 60 * 1000;

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

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("pipeline: scraper -> normalize -> ingestion run -> SQLite writer -> SQLite reader -> Hono API", () => {
  let storageDir: string;
  let dbDir: string;
  let dbPath: string;
  let writer: CatalogWriter;
  let reader: CatalogReader;
  let clock: FakeClock;
  let server: Hono;

  let productId: number;
  let imageSha: string;

  beforeAll(() => {
    storageDir = mkdtempSync(join(tmpdir(), "scrapito-pipeline-storage-"));
    dbDir = mkdtempSync(join(tmpdir(), "scrapito-pipeline-db-"));
    dbPath = join(dbDir, "scrap.sqlite");
    writer = openCatalogWriter(dbPath, { migrate: true });
    clock = new FakeClock(0);

    reader = openCatalogReader(dbPath);
    const apiConfig: ApiConfig = {
      dbPath,
      storageDir,
      host: "127.0.0.1",
      port: 0,
      publicReads: false,
      webOrigins: [],
    };
    server = createServer(reader, apiConfig);
  });

  afterAll(() => {
    reader.close();
    writer.close();
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function runFixtureOnce() {
    const policy = new CrawlPolicy({
      userAgent: HONEST_UA,
      httpFetch: makeHttpFetch(),
      imageFetch: makeImageFetch(),
      clock,
      random: () => 0.5,
    });
    const images = new ImageWorker(policy, writer.catalog, storageDir, nullLogger);
    const runner = new ScrapeRunner({
      policy,
      catalog: writer.catalog,
      runs: writer.runs,
      images,
      clock,
      logger: nullLogger,
    });
    const scraper = getScraper("fixture-products");
    if (!scraper) throw new Error("fixture-products scraper not registered");
    return pumpUntilSettled(
      clock,
      runner.run(scraper, {}, { maxRequests: 10, maxDurationMs: 30_000, downloadImages: true }),
    );
  }

  test(
    "first run: synchronous ingestion completes and the read-only catalog/search/image API reflects it",
    async () => {
      const outcome = await runFixtureOnce();
      expect(outcome.status).toBe("completed");
      expect(outcome.productsSaved).toBe(2);
      expect(outcome.productsRejected).toBe(0);

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

      const priceRes = await server.request(`/products/${productId}/prices`);
      expect(priceRes.status).toBe(200);
      const priceBody = await readJson<{ data: PriceObservation[] }>(priceRes);
      expect(priceBody.data).toHaveLength(1);
      expect(priceBody.data[0]?.regularCents).toBe(199900);

      const searchRes = await server.request("/search?q=Refrigeradora");
      expect(searchRes.status).toBe(200);
      const searchBody = await readJson<{ data: ProductSummary[] }>(searchRes);
      expect(searchBody.data.some((p) => p.id === productId)).toBe(true);

      const offersRes = await server.request("/offers?sort=discount_desc");
      expect(offersRes.status).toBe(200);
      const offersBody = await readJson<{ data: { id: number; quality: string; discountBps: number | null }[] }>(
        offersRes,
      );
      const fridgeOffer = offersBody.data.find((o) => o.id === productId);
      expect(fridgeOffer?.quality).toBe("verified_discount");

      const imageRes = await server.request(`/images/${imageSha}`);
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get("etag")).toBe(`"${imageSha}"`);
      expect(imageRes.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await imageRes.arrayBuffer());
      expect(Array.from(bytes)).toEqual(Array.from(PNG_BYTES));

      const updatesRes = await server.request("/updates");
      expect(updatesRes.status).toBe(200);
      const updatesBody = await readJson<{ data: { status: string; runId: number }[] }>(updatesRes);
      expect(updatesBody.data.some((u) => u.runId === outcome.runId && u.status === "completed")).toBe(true);

      const freshnessRes = await server.request("/freshness");
      expect(freshnessRes.status).toBe(200);
      const freshnessBody = await readJson<{ data: { storeId: string; lastSuccessfulAt: string | null }[] }>(
        freshnessRes,
      );
      const falabella = freshnessBody.data.find((f) => f.storeId === "falabella-pe");
      expect(falabella?.lastSuccessfulAt).not.toBeNull();
    },
    10000,
  );

  test(
    "re-run past the freshness window: same product identity, change-gated price, deduped image",
    async () => {
      await clock.advance(DOC_FRESHNESS_MS + 60 * 60 * 1000);
      const outcome = await runFixtureOnce();
      expect(outcome.status).toBe("completed");

      const listRes = await server.request("/products");
      const listBody = await readJson<Page<ProductSummary>>(listRes);
      expect(listBody.data).toHaveLength(2);
      const fridge = listBody.data.find((p) => p.externalId === "20936199");
      if (!fridge) throw new Error("expected the fridge fixture product to still be persisted");
      expect(fridge.id).toBe(productId);

      const priceRes = await server.request(`/products/${productId}/prices`);
      const priceBody = await readJson<{ data: PriceObservation[] }>(priceRes);
      expect(priceBody.data).toHaveLength(1);
      expect(shaFromImageUrl(fridge.imageUrl)).toBe(imageSha);
    },
    10000,
  );
});
