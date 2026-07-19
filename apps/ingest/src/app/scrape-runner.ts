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
  type TargetIdentityInput,
  type RunProvenance,
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
  /** Explicit audited target. Legacy callers may omit it; no sighting is fabricated. */
  target?: TargetIdentityInput;
  /** Caller-supplied audit correlation. It never controls scheduling. */
  provenance?: Pick<RunProvenance, "invocationId" | "strategy" | "capability">;
  authoritativeCoverage?: boolean;
  coverageBoundary?: Record<string, unknown>;
  /** Caller-owned threshold; valid only when this run produces complete,
   * authoritative coverage. Omit to collect misses without deactivation. */
  inactivityMissThreshold?: number;
}

export interface RunOutcome {
  runId: number;
  coverageId: number | null;
  coverageStatus: "complete" | "partial" | "failed" | null;
  coverageAuthoritative: boolean;
  coverageBoundary: Record<string, unknown> | null;
  coverageStopReason:
    | "completed"
    | "budget_exhausted"
    | "challenge"
    | "circuit_open"
    | "error"
    | null;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  productsSaved: number;
  productsSeen: number;
  productsRejected: number;
  duplicatesSeen: number;
  requestsMade: number;
  imagesDownloaded: number;
  writerDurationMs: number;
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
    const runId = this.deps.runs.start(scraper.id, scraper.store, {
      ...options.provenance,
      params,
      maxRequests,
      maxDurationMs,
    });
    const coverage =
      options.target == null
        ? null
        : this.deps.runs.startCoverage(runId, {
            target: options.target,
            maxRequests,
            maxDurationMs,
            requestedPages: null,
          });
    const startedAt = new Date().toISOString();
    const stats = { saved: 0, rejected: 0, requests: 0, images: 0, duplicates: 0, writerMs: 0 };
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
      const result = (() => {
        const writerStarted = performance.now();
        try {
          return this.deps.catalog.productSnapshot(
            runId,
            scraper.store,
            parsed.data,
            variants,
            coverage == null ? {} : { coverageId: coverage.coverageId },
          );
        } finally {
          stats.writerMs += performance.now() - writerStarted;
        }
      })();
      stats.saved++;
      if (coverage != null && !result.sightingInserted) stats.duplicates++;
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
    let coverageStopReason:
      | "completed"
      | "budget_exhausted"
      | "challenge"
      | "circuit_open"
      | "error" = "completed";
    let error: string | undefined;
    try {
      await scraper.scrape(ctx);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        status = "partial";
        coverageStopReason = "budget_exhausted";
      } else if (err instanceof ChallengeDetectedError) {
        status = "failed";
        coverageStopReason = "challenge";
        error = err.message;
      } else if (err instanceof CircuitOpenError) {
        status = "failed";
        coverageStopReason = "circuit_open";
        error = err.message;
      } else {
        status = "failed";
        coverageStopReason = "error";
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
    if (coverage != null) {
      this.deps.runs.finishCoverage(coverage.coverageId, {
        status: status === "completed" ? "complete" : status,
        authoritative: status === "completed" && options.authoritativeCoverage === true,
        stopReason: coverageStopReason,
        requestsMade: budget.used,
        productsSeen: stats.saved - stats.duplicates,
        duplicatesSeen: stats.duplicates,
        productsRejected: stats.rejected,
        boundary: options.coverageBoundary ?? null,
        inactivityMissThreshold: options.inactivityMissThreshold ?? null,
      });
    }

    this.deps.runs.finish(runId, status, {
      productsSaved: stats.saved,
      productsRejected: stats.rejected,
      requestsMade: budget.used,
      imagesDownloaded: stats.images,
      lastError: error ?? null,
    });

    return {
      runId,
      coverageId: coverage?.coverageId ?? null,
      coverageStatus: coverage == null ? null : status === "completed" ? "complete" : status,
      coverageAuthoritative:
        coverage != null && status === "completed" && options.authoritativeCoverage === true,
      coverageBoundary: coverage == null ? null : (options.coverageBoundary ?? null),
      coverageStopReason: coverage == null ? null : coverageStopReason,
      status,
      startedAt,
      finishedAt,
      productsSaved: stats.saved,
      productsSeen: stats.saved - stats.duplicates,
      productsRejected: stats.rejected,
      duplicatesSeen: stats.duplicates,
      requestsMade: budget.used,
      imagesDownloaded: stats.images,
      writerDurationMs: Math.ceil(stats.writerMs),
      error,
    };
  }
}
