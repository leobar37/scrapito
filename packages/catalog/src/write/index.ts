/**
 * Write-side catalog facade. Opens (creating if needed) one SQLite database in
 * WAL mode, optionally runs migrations, and exposes every write-capable store.
 * Only @scrapito/ingest may import this subpath.
 */
import type { Database } from "bun:sqlite";
import { migrationsPending, openWriterDatabase, runMigrations } from "./db.ts";
import { CatalogStore } from "./catalog-store.ts";
import { RunStore } from "./run-store.ts";
import { SqliteHttpCache } from "./sqlite-http-cache.ts";
import { SqliteTabStore } from "./sqlite-tab-store.ts";
import { WriterLease } from "./writer-lease.ts";

export interface CatalogWriter {
  db: Database;
  catalog: CatalogStore;
  runs: RunStore;
  httpCache: SqliteHttpCache;
  tabStore: SqliteTabStore;
  writerLease: WriterLease;
  close(): void;
}

export function openCatalogWriter(
  path: string,
  options: { migrate?: boolean; requireMigrated?: boolean } = {},
): CatalogWriter {
  const db = openWriterDatabase(path);
  if (options.migrate) runMigrations(db);
  if (options.requireMigrated && migrationsPending(db)) {
    throw new Error("database has pending migrations; run `bun run db:migrate`");
  }
  return {
    db,
    catalog: new CatalogStore(db),
    runs: new RunStore(db),
    httpCache: new SqliteHttpCache(db),
    tabStore: new SqliteTabStore(db),
    writerLease: new WriterLease(db),
    close: () => db.close(),
  };
}

export { openWriterDatabase, runMigrations, migrationsPending } from "./db.ts";
export type { MigrationResult } from "./db.ts";
export { CatalogStore } from "./catalog-store.ts";
export type { SnapshotResult } from "./catalog-store.ts";
export { RunStore } from "./run-store.ts";
export { SqliteHttpCache } from "./sqlite-http-cache.ts";
export type { HttpCacheEntry, HttpCacheStore } from "./sqlite-http-cache.ts";
export { SqliteTabStore } from "./sqlite-tab-store.ts";
export type { TabRegistryStore } from "./sqlite-tab-store.ts";
export { WriterLease, WRITER_LEASE_NAME, WRITER_LEASE_TTL_MS, WRITER_LEASE_HEARTBEAT_MS } from "./writer-lease.ts";
export type { ImageDestinationKind, ImageSourceRow, ImageSourceTargetRow, ProductRow, PriceRow, VariantRow, RunRow, WriterLeaseRow } from "../rows.ts";
