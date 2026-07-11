/**
 * Single-writer lease over `writer_leases`. Only one ingestion process may
 * hold the `catalog-ingest` lease at a time; acquisition is atomic (an
 * unexpired lease held by another token fails immediately), the holder
 * refreshes a 60s TTL every ~10s, and release only clears the row when the
 * caller still owns the current token (a lost lease means the run must abort
 * as failed rather than silently keep writing).
 */
import type { Database } from "bun:sqlite";
import { WriterLockedError } from "@scrapito/contracts";
import type { WriterLeaseRow } from "../rows.ts";

export const WRITER_LEASE_NAME = "catalog-ingest";
export const WRITER_LEASE_TTL_MS = 60_000;
export const WRITER_LEASE_HEARTBEAT_MS = 10_000;

function randomToken(): string {
  return crypto.randomUUID();
}

export class WriterLease {
  private token: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database,
    private readonly name: string = WRITER_LEASE_NAME,
    private readonly ttlMs: number = WRITER_LEASE_TTL_MS,
  ) {}

  /** Atomically acquire the lease, reclaiming an expired row. Throws
   * WriterLockedError immediately when a non-expired lease is held by
   * another token. */
  acquire(now: number = Date.now()): string {
    const token = randomToken();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .query<WriterLeaseRow, [string]>("SELECT * FROM writer_leases WHERE name = ?")
        .get(this.name);
      if (existing && existing.expires_at > now) {
        this.db.exec("ROLLBACK");
        throw new WriterLockedError(
          `writer lease '${this.name}' is held by another ingestion process`,
        );
      }
      this.db
        .query(
          `INSERT INTO writer_leases (name, token, expires_at, heartbeat_at)
             VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             token = excluded.token, expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(this.name, token, now + this.ttlMs, now);
      this.db.exec("COMMIT");
    } catch (err) {
      if (!(err instanceof WriterLockedError)) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* transaction may already be closed */
        }
      }
      throw err;
    }
    this.token = token;
    return token;
  }

  /** Refresh the TTL for the currently held token. No-op if the token has
   * been lost (e.g. reclaimed after this process stalled). Returns false
   * when the lease was lost. */
  heartbeat(now: number = Date.now()): boolean {
    if (!this.token) return false;
    const res = this.db
      .query("UPDATE writer_leases SET expires_at = ?, heartbeat_at = ? WHERE name = ? AND token = ?")
      .run(now + this.ttlMs, now, this.name, this.token);
    return Number(res.changes) > 0;
  }

  /** Start a background heartbeat loop; call stopHeartbeat() before release(). */
  startHeartbeat(intervalMs: number = WRITER_LEASE_HEARTBEAT_MS): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
    if (typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      (this.heartbeatTimer as unknown as { unref(): void }).unref();
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Release only the row matching our owner token. */
  release(): void {
    this.stopHeartbeat();
    if (!this.token) return;
    this.db.query("DELETE FROM writer_leases WHERE name = ? AND token = ?").run(this.name, this.token);
    this.token = null;
  }

  get currentToken(): string | null {
    return this.token;
  }
}
