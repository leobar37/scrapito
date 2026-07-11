#!/usr/bin/env bun
/**
 * `scrap-ingest` operator/agent CLI. Manages migrations, discovery, scraper
 * validation, and synchronous ingestion runs. There is no job queue and no
 * HTTP server here — that is `apps/api`. `discover` never executes or
 * promotes generated source; `scrapers validate` runs offline (no network,
 * no agent-browser).
 */
import { Command } from "commander";
import { rmSync } from "node:fs";
import {
  ProductInputSchema,
  ScrapError,
  WriterLockedError,
  decodeOfferSearchParams,
  encodeOfferSearchParams,
  type IngestionRunResult,
  type Pages,
} from "@scrapito/contracts";
import { openCatalogReader } from "@scrapito/catalog/read";
import { WriterLease, migrationsPending, openWriterDatabase, runMigrations } from "@scrapito/catalog/write";
import { loadConfig } from "../config.ts";
import { buildIngestRunner, openIngestWriter } from "../app/services.ts";
import { getScraper, listScrapers } from "../scrapers/registry.ts";
import { getDiscovery, listDiscoveries, FsDiscoveryArtifacts } from "../discovery/index.ts";
import { BrowserManager } from "../browser/browser-manager.ts";
import { CrawlPolicy, defaultHttpFetch, defaultImageFetch } from "../policy/crawl-policy.ts";
import { createLogger } from "../util/logger.ts";

function parsePages(value: string | undefined): Pages | undefined {
  if (!value) return undefined;
  const range = value.match(/^(\d+)-(\d+)$/);
  if (range && range[1] && range[2]) {
    return { from: Number(range[1]), to: Number(range[2]) };
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function jsonErrorAndExit(json: boolean, code: string, message: string, details?: unknown): never {
  if (json) {
    console.log(JSON.stringify({ error: { code, message, ...(details !== undefined ? { details } : {}) } }));
  } else {
    console.error(`${code}: ${message}`);
  }
  process.exit(1);
}

const program = new Command();
program.name("scrap-ingest").description("Scrapito ingestion CLI (synchronous, single-writer)");

// ---- db ----
const db = program.command("db").description("database management (write side)");
db.command("migrate")
  .description("apply pending migrations (idempotent)")
  .action(() => {
    const config = loadConfig();
    const database = openWriterDatabase(config.dbPath);
    const result = runMigrations(database);
    console.log(JSON.stringify({ applied: result.applied, alreadyApplied: result.alreadyApplied }));
    database.close();
  });
db.command("reset")
  .description("DROP and recreate the database")
  .option("--yes", "confirm destructive reset")
  .action((opts: { yes?: boolean }) => {
    if (!opts.yes) {
      console.error("refusing to reset without --yes");
      process.exit(1);
    }
    const config = loadConfig();
    try {
      rmSync(config.dbPath, { force: true });
      rmSync(config.dbPath + "-wal", { force: true });
      rmSync(config.dbPath + "-shm", { force: true });
    } catch {
      /* ignore */
    }
    const database = openWriterDatabase(config.dbPath);
    runMigrations(database);
    database.close();
    console.log("database reset");
  });

// ---- browser (local-only) ----
const browser = program.command("browser").description("agent-browser management (local-only)");
browser.command("install").action(async () => {
  await runBrowserCli(["install"]);
});
browser.command("doctor").action(async () => {
  await runBrowserCli(["doctor", "--json"]);
});

async function runBrowserCli(args: string[]): Promise<void> {
  const config = loadConfig();
  const proc = Bun.spawn([config.agentBrowserBin, ...args], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

// ---- stores (read-only, no lease needed) ----
program
  .command("stores")
  .command("list")
  .description("list configured stores")
  .action(() => {
    const config = loadConfig();
    const reader = openCatalogReader(config.dbPath);
    console.log(JSON.stringify(reader.queries.listStores(), null, 2));
    reader.close();
  });

// ---- scrapers (local-only, offline) ----
const scrapers = program.command("scrapers").description("registered scrapers (local-only)");
scrapers.command("list").action(() => {
  console.log(
    JSON.stringify(
      listScrapers().map((s) => ({ id: s.id, store: s.store, version: s.version, defaults: s.defaults })),
      null,
      2,
    ),
  );
});
scrapers
  .command("validate <fileOrId>")
  .description("offline static + fixture validation (no network, no browser)")
  .action((fileOrId: string) => {
    const scraper = getScraper(fileOrId);
    if (!scraper) {
      console.error(`unknown scraper id: ${fileOrId}`);
      process.exit(1);
    }
    if (!scraper.selfCheck) {
      console.error(`scraper ${fileOrId} has no selfCheck fixtures`);
      process.exit(1);
    }
    const products = scraper.selfCheck();
    let valid = 0;
    const errors: string[] = [];
    for (const p of products) {
      const r = ProductInputSchema.safeParse(p);
      if (r.success) valid++;
      else errors.push(r.error.issues[0]?.message ?? "invalid");
    }
    if (errors.length > 0) {
      console.error(JSON.stringify({ ok: false, valid, errors }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, scraper: scraper.id, products: products.length, valid }));
  });

// ---- discover (local-only reconnaissance; never registers/promotes anything) ----
const discover = program.command("discover").description("local-only browser reconnaissance (never auto-registers)");
discover.command("list").action(() => {
  console.log(JSON.stringify(listDiscoveries().map((d) => ({ scraperId: d.scraperId, store: d.store })), null, 2));
});
discover
  .command("run <scraperId>")
  .description("capture SSR/HAR artifacts for an operator to author a scraper from")
  .action(async (scraperId: string) => {
    const discovery = getDiscovery(scraperId);
    if (!discovery) {
      console.error(`unknown discovery id: ${scraperId}`);
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.userAgent) {
      console.error("SCRAP_USER_AGENT must be set to run discovery");
      process.exit(1);
    }
    const { writer, logger, close } = openIngestWriter(config, { requireMigrated: true });
    const lease = new WriterLease(writer.db);
    try {
      lease.acquire();
    } catch (err) {
      close();
      if (err instanceof WriterLockedError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    lease.startHeartbeat();
    try {
      const policy = new CrawlPolicy({
        userAgent: config.userAgent,
        httpFetch: defaultHttpFetch(),
        imageFetch: defaultImageFetch(),
        cache: writer.httpCache,
        logger,
      });
      const browserManager = new BrowserManager({
        bin: config.agentBrowserBin,
        timeoutMs: config.agentBrowserTimeoutMs,
        logger,
        tabStore: writer.tabStore,
      });
      const session = await browserManager.start({ session: `discover-${scraperId}`, userAgent: config.userAgent });
      const runId = `${scraperId}-${Date.now()}`;
      const artifacts = new FsDiscoveryArtifacts(config.discoveryDir, runId);
      try {
        await discovery.run({ browser: session, policy, artifacts, logger });
        console.log(JSON.stringify({ ok: true, dir: artifacts.dir }));
      } finally {
        await session.close().catch(() => {});
      }
    } finally {
      lease.release();
      close();
    }
  });

// ---- run (synchronous ingestion; the only way to write products) ----
program
  .command("run <scraperId>")
  .option("--category <value>")
  .option("--search <term>", "keyword search (e.g. juguetes)")
  .option("--pages <n|a-b>")
  .option("--max-requests <n>", "max requests", (v) => Number(v))
  .option("--max-duration <ms>", "max duration ms", (v) => Number(v))
  .option("--no-images", "skip image downloads")
  .option("--json", "emit exactly one JSON result line on stdout; logs go to stderr")
  .action(async (scraperId: string, opts: Record<string, unknown>) => {
    const json = Boolean(opts.json);
    const scraper = getScraper(scraperId);
    if (!scraper) {
      jsonErrorAndExit(json, "UNKNOWN_SCRAPER", `unknown scraper id: ${scraperId}`);
    }
    const params = {
      category: opts.category as string | undefined,
      search: opts.search as string | undefined,
      pages: parsePages(opts.pages as string | undefined),
    };
    const parsed = scraper.paramsSchema.safeParse(params);
    if (!parsed.success) {
      jsonErrorAndExit(json, "BAD_REQUEST", "invalid scraper params", parsed.error.issues);
    }

    const config = loadConfig();
    if (!config.userAgent) {
      jsonErrorAndExit(json, "POLICY_DENIED", "SCRAP_USER_AGENT must be set to run scrapers");
    }

    let opened: ReturnType<typeof openIngestWriter>;
    try {
      opened = openIngestWriter(config, { requireMigrated: true });
    } catch (err) {
      jsonErrorAndExit(json, "DB_NOT_READY", err instanceof Error ? err.message : String(err));
    }
    const { writer, logger, close } = opened;
    const lease = new WriterLease(writer.db);
    try {
      lease.acquire();
    } catch (err) {
      close();
      if (err instanceof WriterLockedError) {
        jsonErrorAndExit(json, "WRITER_LOCKED", err.message);
      }
      throw err;
    }
    lease.startHeartbeat();

    const recovered = writer.runs.failStaleRunning("ingest_restarted");
    if (recovered > 0) logger.warn("recovered stale running runs on startup", { recovered });

    try {
      const { runner } = buildIngestRunner(config, writer, logger);
      const outcome = await runner.run(scraper, params, {
        maxRequests: (opts.maxRequests as number | undefined) ?? scraper.defaults.maxRequests,
        maxDurationMs: (opts.maxDuration as number | undefined) ?? scraper.defaults.maxDurationMs,
        downloadImages: opts.images !== false,
      });

      if (outcome.status === "failed" && !outcome.error) {
        // Lost lease / aborted mid-run: never claim success.
      }

      const result: IngestionRunResult = {
        runId: outcome.runId,
        scraperId: scraper.id,
        storeId: scraper.store,
        status: outcome.status as "completed" | "partial" | "failed",
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        productsSaved: outcome.productsSaved,
        productsRejected: outcome.productsRejected,
        imagesDownloaded: outcome.imagesDownloaded,
        requestsMade: outcome.requestsMade,
        error: outcome.error ?? null,
      };
      if (json) console.log(JSON.stringify(result));
      else console.log(JSON.stringify(result, null, 2));
      process.exitCode = outcome.status === "failed" ? 1 : 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonErrorAndExit(json, err instanceof ScrapError ? err.code : "INTERNAL", message);
    } finally {
      lease.release();
      close();
    }
  });

// ---- offers query (read-only convenience mirroring GET /offers) ----
const offers = program.command("offers").description("read-only offer search (mirrors GET /offers)");
offers
  .command("query")
  .option("--query <q>", "search text")
  .option("--store <id>", "repeatable store filter", (v, acc: string[] = []) => [...acc, v], [])
  .option("--category-id <id>", "repeatable category id filter", (v, acc: string[] = []) => [...acc, v], [])
  .option("--brand <name>", "repeatable brand filter", (v, acc: string[] = []) => [...acc, v], [])
  .option("--quality <q>", "repeatable quality filter (verified_discount|promotional_price)", (v, acc: string[] = []) => [...acc, v], [])
  .option("--price-access <a>", "repeatable price access filter (public|card)", (v, acc: string[] = []) => [...acc, v], [])
  .option("--min-effective-cents <n>")
  .option("--max-effective-cents <n>")
  .option("--min-discount-bps <n>")
  .option("--include-out-of-stock", "include out-of-stock offers")
  .option("--sort <sort>", "relevance|discount_desc|price_asc|price_desc|updated_desc")
  .option("--limit <n>")
  .option("--cursor <cursor>")
  .option("--api-base-url <url>", "API base URL", process.env.SCRAP_API_BASE_URL ?? "http://127.0.0.1:3000")
  .option("--json", "print the raw JSON envelope")
  .action(async (opts: Record<string, unknown>) => {
    const params = new URLSearchParams();
    if (opts.query) params.set("q", String(opts.query));
    for (const s of (opts.store as string[]) ?? []) params.append("store", s);
    for (const c of (opts.categoryId as string[]) ?? []) params.append("categoryId", c);
    for (const b of (opts.brand as string[]) ?? []) params.append("brand", b);
    for (const q of (opts.quality as string[]) ?? []) params.append("quality", q);
    for (const p of (opts.priceAccess as string[]) ?? []) params.append("priceAccess", p);
    if (opts.minEffectiveCents) params.set("minEffectiveCents", String(opts.minEffectiveCents));
    if (opts.maxEffectiveCents) params.set("maxEffectiveCents", String(opts.maxEffectiveCents));
    if (opts.minDiscountBps) params.set("minDiscountBps", String(opts.minDiscountBps));
    if (opts.includeOutOfStock) params.set("inStock", "false");
    if (opts.sort) params.set("sort", String(opts.sort));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", String(opts.cursor));

    // Validate/normalize locally so CLI/web/API share identical semantics
    // before ever hitting the network.
    let normalized: URLSearchParams;
    try {
      normalized = encodeOfferSearchParams(decodeOfferSearchParams(params));
    } catch (err) {
      jsonErrorAndExit(true, err instanceof ScrapError ? err.code : "BAD_REQUEST", err instanceof Error ? err.message : String(err));
    }

    const base = String(opts.apiBaseUrl).replace(/\/$/, "");
    const url = `${base}/offers?${normalized.toString()}`;
    const res = await fetch(url);
    const body: unknown = await res.json();
    if (!res.ok) {
      console.log(JSON.stringify(body));
      process.exit(1);
    }
    console.log(opts.json ? JSON.stringify(body) : JSON.stringify(body, null, 2));
  });

program.parseAsync(process.argv);
