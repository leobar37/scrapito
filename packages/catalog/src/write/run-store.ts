/** RunStore — tracks scraper_runs and scraper_run_events for observability.
 * Runs are audit-only (no job queue); `failStaleRunning` recovers orphaned
 * `running` rows left by a crashed/killed ingestion process. */
import type { Database } from "bun:sqlite";
import type { RunStatus, StoreId } from "@scrapito/contracts";
import type { RunRow } from "../rows.ts";

export class RunStore {
  constructor(private readonly db: Database) {}

  start(scraperId: string, store: StoreId): number {
    const res = this.db
      .query(
        `INSERT INTO scraper_runs (scraper_id, store_id, status, started_at)
         VALUES (?,?, 'running', ?)`,
      )
      .run(scraperId, store, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  finish(
    runId: number,
    status: RunStatus,
    fields: {
      productsSaved: number;
      productsRejected: number;
      requestsMade: number;
      imagesDownloaded: number;
      lastError?: string | null;
    },
  ): void {
    this.db
      .query(
        `UPDATE scraper_runs SET status=?, finished_at=?, products_saved=?, products_rejected=?,
           requests_made=?, images_downloaded=?, last_error=? WHERE id=?`,
      )
      .run(
        status,
        new Date().toISOString(),
        fields.productsSaved,
        fields.productsRejected,
        fields.requestsMade,
        fields.imagesDownloaded,
        fields.lastError ?? null,
        runId,
      );
  }

  event(runId: number, level: string, message: string, data?: unknown): void {
    this.db
      .query("INSERT INTO scraper_run_events (run_id, at, level, message, data_json) VALUES (?,?,?,?,?)")
      .run(runId, new Date().toISOString(), level, message, data !== undefined ? JSON.stringify(data) : null);
  }

  get(id: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM scraper_runs WHERE id=?").get(id);
  }

  /** Mark orphaned `running` runs failed on ingestion startup (after
   * acquiring the writer lease). Returns how many were recovered. */
  failStaleRunning(reason = "ingest_restarted"): number {
    const now = new Date().toISOString();
    const res = this.db
      .query(
        "UPDATE scraper_runs SET status='failed', finished_at=?, last_error=? WHERE status='running'",
      )
      .run(now, reason);
    const changed = Number(res.changes);
    if (changed > 0) {
      const stale = this.db
        .query<{ id: number }, [string, string]>("SELECT id FROM scraper_runs WHERE last_error=? AND finished_at=?")
        .all(reason, now);
      for (const row of stale) {
        this.event(row.id, "error", "run marked failed on ingestion restart", { reason });
      }
    }
    return changed;
  }
}
