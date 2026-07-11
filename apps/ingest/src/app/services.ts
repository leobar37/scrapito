/**
 * Ingestion composition root. The CLI is the only entry point; there is no
 * server, no worker loop, no job queue. `openIngestWriter` opens the
 * writer-capable catalog (so the CLI can acquire the writer lease before any
 * scrape runs); `buildIngestRunner` wires policy/images/browser/runner on top
 * of an already-open writer.
 */
import { openCatalogWriter, type CatalogWriter } from "@scrapito/catalog/write";
import { PolicyError } from "@scrapito/contracts";
import type { IngestConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { CrawlPolicy, defaultHttpFetch, defaultImageFetch } from "../policy/crawl-policy.ts";
import { ImageWorker } from "../images/image-worker.ts";
import { BrowserManager } from "../browser/browser-manager.ts";
import { ScrapeRunner } from "./scrape-runner.ts";
import { createLogger, type Logger } from "../util/logger.ts";

export interface OpenIngestWriterResult {
  config: IngestConfig;
  writer: CatalogWriter;
  logger: Logger;
  close(): void;
}

export function openIngestWriter(
  config: IngestConfig = loadConfig(),
  options: { migrate?: boolean; requireMigrated?: boolean } = {},
): OpenIngestWriterResult {
  const logger = createLogger();
  const writer = openCatalogWriter(config.dbPath, {
    migrate: options.migrate,
    requireMigrated: options.requireMigrated ?? true,
  });
  return { config, writer, logger, close: () => writer.close() };
}

export interface IngestRunner {
  policy: CrawlPolicy;
  images: ImageWorker;
  browserManager: BrowserManager;
  runner: ScrapeRunner;
}

/** Wire policy/images/browser/runner on top of an already-open writer.
 * Requires a configured honest SCRAP_USER_AGENT. */
export function buildIngestRunner(config: IngestConfig, writer: CatalogWriter, logger: Logger): IngestRunner {
  if (!config.userAgent) {
    throw new PolicyError("SCRAP_USER_AGENT must be set to run scrapers");
  }
  const browserArgs = process.env.AGENT_BROWSER_ARGS ? undefined : ["--no-sandbox"];
  const policy = new CrawlPolicy({
    userAgent: config.userAgent,
    httpFetch: defaultHttpFetch(),
    imageFetch: defaultImageFetch(),
    cache: writer.httpCache,
    logger,
  });
  const images = new ImageWorker(policy, writer.catalog, config.storageDir, logger);
  const browserManager = new BrowserManager({
    bin: config.agentBrowserBin,
    timeoutMs: config.agentBrowserTimeoutMs,
    logger,
    tabStore: writer.tabStore,
  });
  const runner = new ScrapeRunner({
    policy,
    catalog: writer.catalog,
    runs: writer.runs,
    images,
    browserManager,
    browserArgs,
    logger,
  });
  return { policy, images, browserManager, runner };
}

export interface IngestServices extends IngestRunner {
  config: IngestConfig;
  writer: CatalogWriter;
  logger: Logger;
  close(): void;
}

/** Convenience one-shot composition (no lease control) — used by tests. CLI
 * `run`/`discover` use openIngestWriter + a WriterLease + buildIngestRunner
 * directly so the lease is held before any scrape/browser work starts. */
export function createIngestServices(
  config: IngestConfig = loadConfig(),
  options: { migrate?: boolean; requireMigrated?: boolean } = {},
): IngestServices {
  const opened = openIngestWriter(config, options);
  const built = buildIngestRunner(opened.config, opened.writer, opened.logger);
  return { ...opened, ...built };
}
