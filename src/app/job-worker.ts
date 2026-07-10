/**
 * JobWorker — one SQLite writer/job worker. Claims queued jobs atomically, runs
 * them through the ScrapeRunner, and records terminal status. On startup, stale
 * `running` jobs are reset to failed with reason `worker_restarted`.
 */
import { JobInputSchema, type RunStatus } from "../domain/schemas.ts";
import type { JobStore } from "../persistence/job-store.ts";
import type { JobRow } from "../persistence/rows.ts";
import { getScraper } from "../scrapers/registry.ts";
import { systemClock, type Clock } from "../policy/clock.ts";
import { nullLogger, type Logger } from "../util/logger.ts";
import type { ScrapeRunner } from "./scrape-runner.ts";

const JOB_STATUS_BY_RUN: Record<RunStatus, "completed" | "failed" | "partial" | "cancelled"> = {
  queued: "failed",
  running: "failed",
  completed: "completed",
  retry_wait: "failed",
  failed: "failed",
  cancelled: "cancelled",
  partial: "partial",
};

export class JobWorker {
  private running = false;
  private stopped = false;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(
    private readonly jobs: JobStore,
    private readonly runner: ScrapeRunner,
    options: { clock?: Clock; logger?: Logger } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
  }

  /** Move stale running jobs to failed; call once on startup. */
  recover(): number {
    return this.jobs.resetStaleRunning();
  }

  private async execute(job: JobRow): Promise<void> {
    const scraper = getScraper(job.scraper_id);
    if (!scraper) {
      this.jobs.finish(job.id, "failed", { lastError: `unknown scraper: ${job.scraper_id}` });
      return;
    }
    const parsed = JobInputSchema.safeParse(JSON.parse(job.params_json));
    if (!parsed.success) {
      this.jobs.finish(job.id, "failed", { lastError: "invalid job params" });
      return;
    }
    const input = parsed.data;
    try {
      const outcome = await this.runner.run(scraper, input, {
        jobId: job.id,
        maxRequests: job.max_requests,
        maxDurationMs: job.max_duration_ms,
        downloadImages: input.downloadImages,
      });
      this.jobs.finish(job.id, JOB_STATUS_BY_RUN[outcome.status], {
        productsSaved: outcome.productsSaved,
        productsRejected: outcome.productsRejected,
        lastError: outcome.error ?? null,
      });
    } catch (err) {
      this.jobs.finish(job.id, "failed", {
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Claim and run a single job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = this.jobs.claimNext();
    if (!job) return false;
    this.logger.info("job claimed", { jobId: job.id, scraper: job.scraper_id });
    await this.execute(job);
    return true;
  }

  /** Run queued jobs until none remain. Returns how many ran. */
  async drain(): Promise<number> {
    let count = 0;
    while (await this.runOnce()) count++;
    return count;
  }

  /** Long-running poll loop; call stop() to end. */
  async loop(pollMs = 1000): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    while (!this.stopped) {
      const did = await this.runOnce();
      if (!did) await this.clock.sleep(pollMs);
    }
    this.running = false;
  }

  stop(): void {
    this.stopped = true;
  }
}
