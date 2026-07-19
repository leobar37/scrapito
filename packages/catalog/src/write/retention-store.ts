import type { Database } from "bun:sqlite";
import {
  RetentionRequestSchema,
  RetentionResultSchema,
  type RetentionRequest,
  type RetentionResult,
} from "@scrapito/contracts";
import { WRITER_LEASE_NAME } from "./writer-lease.ts";

interface RetentionAuditRow {
  id: number;
  request_json: string;
  result_json: string;
}

interface SightingIdRow {
  id: number;
}

/** Explicit bounded retention capability. Callers must acquire the shared
 * writer lease and invoke each batch themselves; this class never schedules or
 * loops. Only redundant sightings are compacted. Price observations are never
 * selected or deleted. */
export class RetentionStore {
  constructor(private readonly db: Database) {}

  run(raw: RetentionRequest, leaseToken: string): RetentionResult {
    const request = RetentionRequestSchema.parse(raw);
    const requestJson = JSON.stringify(request);
    const nowMs = Date.now();
    const lease = this.db
      .query<{ token: string }, [string, string, number]>(
        "SELECT token FROM writer_leases WHERE name=? AND token=? AND expires_at>?",
      )
      .get(WRITER_LEASE_NAME, leaseToken, nowMs);
    if (!lease) throw new Error("retention requires the active catalog writer lease");

    const existing = this.db
      .query<RetentionAuditRow, [string]>(
        "SELECT id, request_json, result_json FROM retention_runs WHERE invocation_id=?",
      )
      .get(request.invocationId);
    if (existing) return this.replay(existing, requestJson);

    return this.db.transaction(() => {
      const raced = this.db
        .query<RetentionAuditRow, [string]>(
          "SELECT id, request_json, result_json FROM retention_runs WHERE invocation_id=?",
        )
        .get(request.invocationId);
      if (raced) return this.replay(raced, requestJson);

      const startedAt = new Date().toISOString();
      const candidateRows = this.db
        .query<SightingIdRow, [string, number]>(
          `SELECT s.id
             FROM product_sightings s
            WHERE s.seen_at < ?
              AND EXISTS (
                SELECT 1
                  FROM product_sightings later
                 WHERE later.product_id=s.product_id
                   AND later.price_observation_id=s.price_observation_id
                   AND (later.seen_at>s.seen_at OR (later.seen_at=s.seen_at AND later.id>s.id))
              )
            ORDER BY s.seen_at, s.id
            LIMIT ?`,
        )
        .all(request.sightingsBefore, request.batchSize + 1);
      const hasMore = candidateRows.length > request.batchSize;
      const candidateIds = candidateRows.slice(0, request.batchSize).map((row) => row.id);
      let sightingsDeleted = 0;
      if (!request.dryRun && candidateIds.length > 0) {
        const placeholders = candidateIds.map(() => "?").join(",");
        const deleted = this.db
          .query(`DELETE FROM product_sightings WHERE id IN (${placeholders})`)
          .run(...candidateIds);
        sightingsDeleted = Number(deleted.changes);
      }

      const finishedAt = new Date().toISOString();
      const inserted = this.db
        .query(
          `INSERT INTO retention_runs
             (invocation_id, request_json, dry_run, started_at, finished_at,
              candidates, sightings_deleted, has_more, result_json)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          request.invocationId,
          requestJson,
          request.dryRun ? 1 : 0,
          startedAt,
          finishedAt,
          candidateIds.length,
          sightingsDeleted,
          hasMore ? 1 : 0,
          "{}",
        );
      const auditId = Number(inserted.lastInsertRowid);
      const result = RetentionResultSchema.parse({
        schemaVersion: 1,
        invocationId: request.invocationId,
        auditId,
        status: "completed",
        dryRun: request.dryRun,
        sightingsBefore: request.sightingsBefore,
        batchSize: request.batchSize,
        candidates: candidateIds.length,
        sightingsDeleted,
        priceObservationsDeleted: 0,
        hasMore,
        startedAt,
        finishedAt,
        replayed: false,
      });
      this.db.query("UPDATE retention_runs SET result_json=? WHERE id=?").run(JSON.stringify(result), auditId);
      return result;
    })();
  }

  private replay(row: RetentionAuditRow, requestJson: string): RetentionResult {
    if (row.request_json !== requestJson) {
      throw new Error("retention invocationId was already used with a different request");
    }
    return RetentionResultSchema.parse({ ...JSON.parse(row.result_json), replayed: true });
  }
}
