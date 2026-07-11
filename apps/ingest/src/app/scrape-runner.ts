/**
 * ScrapeRunner — composes CrawlPolicy, a registered scraper, transactional
 * persistence, the run-scoped image worker, and run state. It never executes
 * arbitrary remote code: it only invokes a statically registered scraper with
 * Zod-validated params. Remote callers may only LOWER the declared budgets.
 * There is no job queue: one call to `run()` is one synchronous ingestion run.
 */
import {
  BudgetExhaustedError,
  ChallengeDetectedError,
  CircuitOpenError,
  ProductInputSchema,
  ScrapError,
  validateVariants,
  type RunStatus,
  type VariantWarning,
} from "@scrapito/contracts";
import type { CatalogStore, RunStore } from "@scrapito/catalog/write";
import { RequestBudget } from "../policy/budget.ts";
import { systemClock, type Clock } from "../policy/clock.ts";
import type { CrawlPolicy, FetchOptions } from "../policy/crawl-policy.ts";
import type { ImageWorker } from "../images/image-worker.ts";
import type { BrowserManager, BrowserSession } from "../browser/browser-manager.ts";
import { nullLogger, type Logger } from "../util/logger.ts";
import type { Scraper } from "../scrapers/define-scraper.ts";
import type { BrowserRecipe, SaveOutcome, ScrapeContext } from "../scrapers/context.ts";

export interface RunnerDeps {
  policy: CrawlPolicy;
  catalog: CatalogStore;
  runs: RunStore;
  images?: ImageWorker;
  browserManager?: BrowserManager;
  browserArgs?: string[];
  clock?: Clock;
  logger?: Logger;
}

export interface RunOptions {
  maxRequests: number;
  maxDurationMs: number;
  downloadImages?: boolean;
}

export interface RunOutcome {
  runId: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  productsSaved: number;
  productsRejected: number;
  requestsMade: number;
  imagesDownloaded: number;
  error?: string;
}

export class ScrapeRunner {
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly deps: RunnerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? nullLogger;
  }

  async run(scraper: Scraper, rawParams: unknown, options: RunOptions): Promise<RunOutcome> {
    const params = scraper.paramsSchema.parse(rawParams);
    // Remote/CLI callers may only lower the declared limits.
    const maxRequests = Math.min(options.maxRequests, scraper.defaults.maxRequests);
    const maxDurationMs = Math.min(options.maxDurationMs, scraper.defaults.maxDurationMs);
    const downloadImages = options.downloadImages ?? scraper.defaults.downloadImages;

    const budget = new RequestBudget(maxRequests, maxDurationMs, this.clock);
    const runId = this.deps.runs.start(scraper.id, scraper.store);
    const startedAt = new Date().toISOString();
    const stats = { saved: 0, rejected: 0, requests: 0, images: 0 };
    let session: BrowserSession | undefined;

    const save = (input: unknown): SaveOutcome => {
      const parsed = ProductInputSchema.safeParse(input);
      if (!parsed.success) {
        stats.rejected++;
        const reason = parsed.error.issues[0]?.message ?? "invalid product";
        this.deps.runs.event(runId, "warn", "product rejected", { reason });
        return { ok: false, error: reason };
      }
      if (parsed.data.store !== scraper.store) {
        stats.rejected++;
        return { ok: false, error: "cross-store write rejected" };
      }
      const { variants, warnings } = validateVariants(parsed.data.variants);
      if (warnings.length > 0) {
        this.deps.runs.event(runId, "warn", "variant warnings", { warnings } satisfies { warnings: VariantWarning[] });
      }
      const result = this.deps.catalog.productSnapshot(runId, scraper.store, parsed.data, variants);
      stats.saved++;
      return {
        ok: true,
        productId: result.productId,
        created: result.created,
        priceInserted: result.priceInserted,
      };
    };

    const httpFetch = async (url: string, fetchOptions?: FetchOptions) => {
      stats.requests++;
      return this.deps.policy.fetch(url, { ...fetchOptions, budget });
    };

    const browserRecipe = async <T>(label: string, recipe: BrowserRecipe<T>): Promise<T> => {
      if (!this.deps.browserManager) {
        throw new ScrapError("NO_BROWSER", "browser recipes require a browser manager");
      }
      if (!session) {
        session = await this.deps.browserManager.start({
          session: `run-${runId}`,
          browserArgs: this.deps.browserArgs,
          userAgent: this.deps.policy.userAgent,
        });
      }
      const tab = await session.tab(label, { purpose: "recipe" });
      return recipe(tab);
    };

    const ctx: ScrapeContext<unknown> = {
      http: { fetch: httpFetch },
      browserRecipe,
      save: { productSnapshot: save },
      logger: this.logger.child({ runId, scraper: scraper.id }),
      run: { id: runId, store: scraper.store, downloadImages },
      params,
      budget,
    };

    let status: RunStatus = "completed";
    let error: string | undefined;
    try {
      await scraper.scrape(ctx);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        status = "partial";
      } else if (err instanceof ChallengeDetectedError || err instanceof CircuitOpenError) {
        status = "failed";
        error = err.message;
      } else {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
      }
      this.deps.runs.event(runId, "error", "scrape error", { error });
    } finally {
      if (session) await session.close().catch(() => {});
    }

    if (downloadImages && this.deps.images && status !== "failed") {
      try {
        const imgResult = await this.deps.images.processRun(runId, 200, budget);
        stats.images = imgResult.downloaded;
      } catch (err) {
        this.logger.warn("image processing error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const finishedAt = new Date().toISOString();
    this.deps.runs.finish(runId, status, {
      productsSaved: stats.saved,
      productsRejected: stats.rejected,
      requestsMade: budget.used,
      imagesDownloaded: stats.images,
      lastError: error ?? null,
    });

    return {
      runId,
      status,
      startedAt,
      finishedAt,
      productsSaved: stats.saved,
      productsRejected: stats.rejected,
      requestsMade: budget.used,
      imagesDownloaded: stats.images,
      error,
    };
  }
}
