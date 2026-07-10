/**
 * Shared application services. The CLI, HTTP server, and worker all compose from
 * here so policy, validation, persistence, and logging cannot drift apart.
 */
import { loadConfig, type AppConfig } from "../config.ts";
import { openPersistence, type Persistence } from "../persistence/index.ts";
import {
  CrawlPolicy,
  defaultHttpFetch,
  defaultImageFetch,
} from "../policy/crawl-policy.ts";
import { ImageWorker } from "../images/image-worker.ts";
import { BrowserManager } from "../sdk/browser/browser-manager.ts";
import { ScrapeRunner } from "./scrape-runner.ts";
import { JobWorker } from "./job-worker.ts";
import { PolicyError } from "../domain/errors.ts";
import { createLogger, type Logger } from "../util/logger.ts";

export interface AppServices {
  config: AppConfig;
  persistence: Persistence;
  logger: Logger;
  close(): void;
}

export interface ScrapingServices {
  policy: CrawlPolicy;
  images: ImageWorker;
  browserManager: BrowserManager;
  runner: ScrapeRunner;
  worker: JobWorker;
}

export function createApp(
  config: AppConfig = loadConfig(),
  options: { migrate?: boolean; requireMigrated?: boolean } = {},
): AppServices {
  const logger = createLogger();
  const persistence = openPersistence(config.dbPath, {
    migrate: options.migrate,
    requireMigrated: options.requireMigrated ?? true,
  });
  return {
    config,
    persistence,
    logger,
    close: () => persistence.close(),
  };
}

/** Build scraping services. Requires a configured honest SCRAP_USER_AGENT. */
export function createScraping(app: AppServices): ScrapingServices {
  if (!app.config.userAgent) {
    throw new PolicyError("SCRAP_USER_AGENT must be set to run scrapers");
  }
  const browserArgs = process.env.AGENT_BROWSER_ARGS
    ? undefined // driver reads env itself
    : ["--no-sandbox"];
  const policy = new CrawlPolicy({
    userAgent: app.config.userAgent,
    httpFetch: defaultHttpFetch(),
    imageFetch: defaultImageFetch(),
    cache: app.persistence.httpCache,
    logger: app.logger,
  });
  const images = new ImageWorker(policy, app.persistence.catalog, app.config.storageDir, app.logger);
  const browserManager = new BrowserManager({
    bin: app.config.agentBrowserBin,
    timeoutMs: app.config.agentBrowserTimeoutMs,
    logger: app.logger,
    tabStore: app.persistence.tabStore,
  });
  const runner = new ScrapeRunner({
    policy,
    catalog: app.persistence.catalog,
    runs: app.persistence.runs,
    images,
    browserManager,
    browserArgs,
    logger: app.logger,
  });
  const worker = new JobWorker(app.persistence.jobs, runner, { logger: app.logger });
  return { policy, images, browserManager, runner, worker };
}
