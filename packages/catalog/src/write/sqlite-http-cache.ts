import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";

/** Structurally identical to @scrapito/ingest's policy HttpCacheStore; kept
 * local so catalog never imports from an app. */
export interface HttpCacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
  status: number;
  fetchedAt: number;
  freshUntil: number;
}

export interface HttpCacheStore {
  get(url: string): HttpCacheEntry | undefined;
  set(entry: HttpCacheEntry): void;
}

interface HttpCacheRow {
  url: string;
  etag: string | null;
  last_modified: string | null;
  body_hash: string | null;
  status: number;
  fetched_at: number;
  fresh_until: number;
}

export class SqliteHttpCache implements HttpCacheStore {
  constructor(private readonly db: Database) {}

  get(url: string): HttpCacheEntry | undefined {
    const r = this.db.query<HttpCacheRow, SQLQueryBindings[]>("SELECT * FROM http_cache WHERE url=?").get(url);
    if (!r) return undefined;
    return {
      url: r.url,
      etag: r.etag,
      lastModified: r.last_modified,
      bodyHash: r.body_hash,
      status: r.status,
      fetchedAt: r.fetched_at,
      freshUntil: r.fresh_until,
    };
  }

  set(entry: HttpCacheEntry): void {
    this.db
      .query(
        `INSERT INTO http_cache (url, etag, last_modified, body_hash, status, fetched_at, fresh_until)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(url) DO UPDATE SET
           etag=excluded.etag, last_modified=excluded.last_modified, body_hash=excluded.body_hash,
           status=excluded.status, fetched_at=excluded.fetched_at, fresh_until=excluded.fresh_until`,
      )
      .run(entry.url, entry.etag, entry.lastModified, entry.bodyHash, entry.status, entry.fetchedAt, entry.freshUntil);
  }
}
