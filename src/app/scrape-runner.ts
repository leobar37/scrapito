/**
 * ScrapeRunner — composes CrawlPolicy, a registered scraper, transactional
 * persistence, the image worker, and run/job state. It never executes arbitrary
 * remote code: it only invokes a statically registered scraper with
 * Zod-validated params. Remote callers may only LOWER the declared budgets.
 */
import {
  BudgetExhaustedError,
  ChallengeDetectedError,
  CircuitOpenError,
  ScrapError,
} from "../domain/errors.ts";
import { ProductInputSchema, type RunStatus } from "../domain/schemas.ts";
import { RequestBudget } from "../policy/budget.ts";
import { systemClock, type Clock } from "../policy/clock.ts";
import type { CrawlPolicy, FetchOptions } from "../policy/crawl-policy.ts";
import type { CatalogStore } from "../persistence/catalog-store.ts";
import type { RunStore } from "../persistence/run-store.ts";
import type { ImageWorker } from "../images/image-worker.ts";
import type { BrowserManager, BrowserSession } from "../sdk/browser/browser-manager.ts";
import { nullLogger, type Logger } from "../util/logger.ts";
import type { Scraper } from "../scrapers/define-scraper.ts";
import type {
  BrowserRecipe,
  SaveOutcome,
  ScrapeContext,
} from "../scrapers/context.ts";

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
  jobId?: number | null;
  maxRequests: number;
  maxDurationMs: number;
  downloadImages?: boolean;
}

export interface RunOutcome {
  runId: number;
  status: RunStatus;
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
    // Remote callers may only lower the declared limits.
    const maxRequests = Math.min(options.maxRequests, scraper.defaults.maxRequests);
    const maxDurationMs = Math.min(options.maxDurationMs, scraper.defaults.maxDurationMs);
    const downloadImages = options.downloadImages ?? scraper.defaults.downloadImages;

    const budget = new RequestBudget(maxRequests, maxDurationMs, this.clock);
    const runId = this.deps.runs.start(scraper.id, scraper.store, options.jobId ?? null);
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
      const result = this.deps.catalog.productSnapshot(scraper.store, parsed.data);
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
        const imgResult = await this.deps.images.processPending(200, budget);
        stats.images = imgResult.downloaded;
      } catch (err) {
        this.logger.warn("image processing error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.deps.runs.finish(runId, status, {
      productsSaved: stats.saved,
      productsRejected: stats.rejected,
      requestsMade: stats.requests,
      lastError: error ?? null,
    });

    return {
      runId,
      status,
      productsSaved: stats.saved,
      productsRejected: stats.rejected,
      requestsMade: stats.requests,
      imagesDownloaded: stats.images,
      error,
    };
  }
}
