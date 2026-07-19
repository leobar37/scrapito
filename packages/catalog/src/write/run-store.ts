/** RunStore — tracks scraper_runs and scraper_run_events for observability.
 * Runs are audit-only (no job queue); `failStaleRunning` recovers orphaned
 * `running` rows left by a crashed/killed ingestion process. */
import type { Database } from "bun:sqlite";
import {
  CoverageFinishInputSchema,
  CoverageStartInputSchema,
  RunProvenanceSchema,
  targetIdentityKey,
  type CoverageFinishInput,
  type CoverageStartInput,
  type RunProvenance,
  type RunStatus,
  type StoreId,
  type TargetKind,
} from "@scrapito/contracts";
import type { RunRow, TargetCoverageRow, TargetIdentityRow, TargetMembershipRow } from "../rows.ts";

export interface CoverageStartResult {
  coverageId: number;
  targetId: number;
}

export class RunStore {
  constructor(private readonly db: Database) {}

  start(scraperId: string, store: StoreId, provenance?: Partial<RunProvenance>): number {
    const parsed = RunProvenanceSchema.parse(provenance ?? {});
    const res = this.db
      .query(
        `INSERT INTO scraper_runs
           (scraper_id, store_id, status, started_at, invocation_id, strategy,
            capability, params_json, max_requests, max_duration_ms)
         VALUES (?,?, 'running', ?,?,?,?,?,?,?)`,
      )
      .run(
        scraperId,
        store,
        new Date().toISOString(),
        parsed.invocationId,
        parsed.strategy,
        parsed.capability,
        parsed.params == null ? null : JSON.stringify(parsed.params),
        parsed.maxRequests,
        parsed.maxDurationMs,
      );
    return Number(res.lastInsertRowid);
  }

  startCoverage(runId: number, input: CoverageStartInput): CoverageStartResult {
    const parsed = CoverageStartInputSchema.parse(input);
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const run = this.db
        .query<Pick<RunRow, "store_id" | "status">, [number]>(
          "SELECT store_id, status FROM scraper_runs WHERE id=?",
        )
        .get(runId);
      if (!run || run.status !== "running") {
        throw new Error(`coverage requires a running run: ${runId}`);
      }

      const identityKey = targetIdentityKey(parsed.target);
      const targetJson = JSON.stringify(parsed.target);
      let target = this.db
        .query<TargetIdentityRow, [StoreId, string]>(
          "SELECT * FROM scrape_target_identities WHERE store_id=? AND identity_key=?",
        )
        .get(run.store_id, identityKey);
      if (!target) {
        const inserted = this.db
          .query(
            `INSERT INTO scrape_target_identities
               (store_id, kind, identity_key, target_json, created_at, updated_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(run.store_id, parsed.target.kind, identityKey, targetJson, now, now);
        target = this.db
          .query<TargetIdentityRow, [number]>("SELECT * FROM scrape_target_identities WHERE id=?")
          .get(Number(inserted.lastInsertRowid));
      } else {
        this.db
          .query("UPDATE scrape_target_identities SET target_json=?, updated_at=? WHERE id=?")
          .run(targetJson, now, target.id);
      }
      if (!target) throw new Error("failed to persist target identity");

      const coverage = this.db
        .query(
          `INSERT INTO target_coverages
             (run_id, target_id, started_at, max_requests, max_duration_ms, requested_pages_json)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          runId,
          target.id,
          now,
          parsed.maxRequests,
          parsed.maxDurationMs,
          parsed.requestedPages == null ? null : JSON.stringify(parsed.requestedPages),
        );
      return { coverageId: Number(coverage.lastInsertRowid), targetId: target.id };
    })();
  }

  finishCoverage(
    coverageId: number,
    input: CoverageFinishInput,
  ): { membershipsMissed: number; membershipsInactivated: number } {
    const parsed = CoverageFinishInputSchema.parse(input);
    return this.db.transaction(() => {
      const coverage = this.db
        .query<TargetCoverageRow & { target_kind: TargetKind }, [number]>(
          `SELECT c.*, t.kind AS target_kind
             FROM target_coverages c
             JOIN scrape_target_identities t ON t.id=c.target_id
            WHERE c.id=?`,
        )
        .get(coverageId);
      if (!coverage || coverage.status !== "running") {
        throw new Error(`coverage is not running: ${coverageId}`);
      }
      if (
        parsed.authoritative &&
        (parsed.status !== "complete" ||
          parsed.boundary == null ||
          coverage.target_kind === "homepage" ||
          coverage.target_kind === "trending")
      ) {
        throw new Error("authoritative coverage requires a complete category/product boundary");
      }

      this.db
        .query(
          `UPDATE target_coverages
              SET status=?, authoritative=?, finished_at=?, requests_made=?,
                  products_seen=?, duplicates_seen=?, products_rejected=?,
                  stop_reason=?, boundary_json=?
            WHERE id=?`,
        )
        .run(
          parsed.status,
          parsed.authoritative ? 1 : 0,
          new Date().toISOString(),
          parsed.requestsMade,
          parsed.productsSeen,
          parsed.duplicatesSeen,
          parsed.productsRejected,
          parsed.stopReason,
          parsed.boundary == null ? null : JSON.stringify(parsed.boundary),
          coverageId,
        );

      if (!parsed.authoritative) {
        return { membershipsMissed: 0, membershipsInactivated: 0 };
      }
      const missed = this.db
        .query(
          `UPDATE target_product_memberships
              SET consecutive_complete_misses=consecutive_complete_misses+1
            WHERE target_id=? AND inactive_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM product_sightings s
                 WHERE s.coverage_id=? AND s.product_id=target_product_memberships.product_id
              )`,
        )
        .run(coverage.target_id, coverageId);
      const inactivated =
        parsed.inactivityMissThreshold == null
          ? 0
          : Number(
              this.db
                .query(
                  `UPDATE target_product_memberships
                      SET inactive_at=?, inactivity_reason='complete_coverage_miss'
                    WHERE target_id=? AND inactive_at IS NULL
                      AND consecutive_complete_misses>=?`,
                )
                .run(new Date().toISOString(), coverage.target_id, parsed.inactivityMissThreshold).changes,
            );
      return {
        membershipsMissed: Number(missed.changes),
        membershipsInactivated: inactivated,
      };
    })();
  }

  markMembershipInactive(
    targetId: number,
    productId: number,
    reason: "complete_coverage_miss" | "explicit_source_signal",
  ): void {
    const membership = this.db
      .query<TargetMembershipRow, [number, number]>(
        "SELECT * FROM target_product_memberships WHERE target_id=? AND product_id=?",
      )
      .get(targetId, productId);
    if (!membership) throw new Error("target membership not found");
    if (reason === "complete_coverage_miss" && membership.consecutive_complete_misses === 0) {
      throw new Error("complete coverage miss evidence is required before inactivity");
    }
    this.db
      .query(
        `UPDATE target_product_memberships
            SET inactive_at=?, inactivity_reason=?
          WHERE target_id=? AND product_id=?`,
      )
      .run(new Date().toISOString(), reason, targetId, productId);
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
    return this.db.transaction(() => {
      this.db
        .query(
          `UPDATE target_coverages
              SET status='failed', authoritative=0, finished_at=?,
                  stop_reason='ingest_restarted'
            WHERE status='running'
              AND run_id IN (SELECT id FROM scraper_runs WHERE status='running')`,
        )
        .run(now);
      const res = this.db
        .query(
          "UPDATE scraper_runs SET status='failed', finished_at=?, last_error=? WHERE status='running'",
        )
        .run(now, reason);
      const changed = Number(res.changes);
      if (changed > 0) {
        const stale = this.db
          .query<{ id: number }, [string, string]>(
            "SELECT id FROM scraper_runs WHERE last_error=? AND finished_at=?",
          )
          .all(reason, now);
        for (const row of stale) {
          this.event(row.id, "error", "run marked failed on ingestion restart", { reason });
        }
      }
      return changed;
    })();
  }
}
