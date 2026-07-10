/** RunStore — tracks scraper_runs and scraper_run_events for observability. */
import type { Database } from "bun:sqlite";
import type { StoreId } from "../domain/ids.ts";
import type { RunStatus } from "../domain/schemas.ts";

export class RunStore {
  constructor(private readonly db: Database) {}

  start(scraperId: string, store: StoreId, jobId: number | null): number {
    const res = this.db
      .query(
        `INSERT INTO scraper_runs (scraper_id, store_id, job_id, status, started_at)
         VALUES (?,?,?, 'running', ?)`,
      )
      .run(scraperId, store, jobId, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  finish(
    runId: number,
    status: RunStatus,
    fields: {
      productsSaved: number;
      productsRejected: number;
      requestsMade: number;
      lastError?: string | null;
    },
  ): void {
    this.db
      .query(
        `UPDATE scraper_runs SET status=?, finished_at=?, products_saved=?, products_rejected=?,
           requests_made=?, last_error=? WHERE id=?`,
      )
      .run(
        status,
        new Date().toISOString(),
        fields.productsSaved,
        fields.productsRejected,
        fields.requestsMade,
        fields.lastError ?? null,
        runId,
      );
  }

  event(runId: number, level: string, message: string, data?: unknown): void {
    this.db
      .query(
        "INSERT INTO scraper_run_events (run_id, at, level, message, data_json) VALUES (?,?,?,?,?)",
      )
      .run(
        runId,
        new Date().toISOString(),
        level,
        message,
        data !== undefined ? JSON.stringify(data) : null,
      );
  }
}
