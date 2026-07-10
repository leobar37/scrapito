/**
 * JobStore — durable scrape job queue. Claiming is atomic (BEGIN IMMEDIATE,
 * queued -> running). Stale `running` jobs are reset to failed on startup.
 */
import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { JobInput, RunStatus } from "../domain/schemas.ts";
import type { JobRow } from "./rows.ts";

export interface EnqueueResult {
  id: number;
  status: "queued";
}

export class JobStore {
  constructor(private readonly db: Database) {}

  enqueue(input: JobInput): EnqueueResult {
    const now = new Date().toISOString();
    const res = this.db
      .query(
        `INSERT INTO scrape_jobs
           (scraper_id, params_json, status, max_requests, max_duration_ms, scheduled_at, created_at)
         VALUES (?,?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        input.scraperId,
        JSON.stringify(input),
        input.maxRequests,
        input.maxDurationMs,
        now,
        now,
      );
    return { id: Number(res.lastInsertRowid), status: "queued" };
  }

  /** Atomically claim the next eligible queued job (scheduled_at <= now). */
  claimNext(now = new Date().toISOString()): JobRow | null {
    // BEGIN IMMEDIATE takes the write lock up front, preventing double-claims.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db
        .query<JobRow, SQLQueryBindings[]>(
          `SELECT * FROM scrape_jobs
             WHERE status='queued' AND scheduled_at <= ?
             ORDER BY scheduled_at, id LIMIT 1`,
        )
        .get(now);
      if (!job) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .query(
          "UPDATE scrape_jobs SET status='running', attempts=attempts+1, started_at=? WHERE id=?",
        )
        .run(now, job.id);
      this.db.exec("COMMIT");
      return { ...job, status: "running", attempts: job.attempts + 1, started_at: now };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  finish(
    id: number,
    status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "partial" | "retry_wait">,
    fields: { productsSaved?: number; productsRejected?: number; lastError?: string | null },
  ): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE scrape_jobs SET status=?, finished_at=?, products_saved=?, products_rejected=?, last_error=? WHERE id=?`,
      )
      .run(
        status,
        status === "retry_wait" ? null : now,
        fields.productsSaved ?? 0,
        fields.productsRejected ?? 0,
        fields.lastError ?? null,
        id,
      );
  }

  /** Move stale `running` jobs to failed on startup. */
  resetStaleRunning(reason = "worker_restarted"): number {
    const now = new Date().toISOString();
    const res = this.db
      .query(
        "UPDATE scrape_jobs SET status='failed', finished_at=?, last_error=? WHERE status='running'",
      )
      .run(now, reason);
    return Number(res.changes);
  }

  /** Requeue a finished job as a NEW queued attempt (never silent replay). */
  retry(id: number): boolean {
    const now = new Date().toISOString();
    const res = this.db
      .query(
        `UPDATE scrape_jobs SET status='queued', scheduled_at=?, finished_at=NULL, last_error=NULL
           WHERE id=? AND status IN ('failed','cancelled','partial')`,
      )
      .run(now, id);
    return Number(res.changes) > 0;
  }

  cancel(id: number): boolean {
    const now = new Date().toISOString();
    const res = this.db
      .query(
        "UPDATE scrape_jobs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(now, id);
    return Number(res.changes) > 0;
  }

  get(id: number): JobRow | null {
    return this.db.query<JobRow, SQLQueryBindings[]>("SELECT * FROM scrape_jobs WHERE id=?").get(id);
  }
}
