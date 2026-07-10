/**
 * Persistence facade. Opens one SQLite database (WAL, FK, busy timeout), runs
 * migrations if requested, and exposes the store/query objects that the app,
 * worker, CLI, and server all share.
 */
import type { Database } from "bun:sqlite";
import { migrationsPending, openDatabase, runMigrations } from "./db.ts";
import { CatalogStore } from "./catalog-store.ts";
import { CatalogQueries } from "./catalog-queries.ts";
import { JobStore } from "./job-store.ts";
import { RunStore } from "./run-store.ts";
import { SqliteHttpCache } from "./sqlite-http-cache.ts";
import { SqliteTabStore } from "./sqlite-tab-store.ts";

export interface Persistence {
  db: Database;
  catalog: CatalogStore;
  queries: CatalogQueries;
  jobs: JobStore;
  runs: RunStore;
  httpCache: SqliteHttpCache;
  tabStore: SqliteTabStore;
  close(): void;
}

export function openPersistence(
  path: string,
  options: { migrate?: boolean; requireMigrated?: boolean } = {},
): Persistence {
  const db = openDatabase(path);
  if (options.migrate) runMigrations(db);
  if (options.requireMigrated && migrationsPending(db)) {
    throw new Error("database has pending migrations; run `scrap db migrate`");
  }
  return {
    db,
    catalog: new CatalogStore(db),
    queries: new CatalogQueries(db),
    jobs: new JobStore(db),
    runs: new RunStore(db),
    httpCache: new SqliteHttpCache(db),
    tabStore: new SqliteTabStore(db),
    close: () => db.close(),
  };
}

export { openDatabase, runMigrations, migrationsPending } from "./db.ts";
export type { MigrationResult } from "./db.ts";
export { CatalogStore } from "./catalog-store.ts";
export type { SnapshotResult } from "./catalog-store.ts";
export { CatalogQueries } from "./catalog-queries.ts";
export { JobStore } from "./job-store.ts";
export type { EnqueueResult } from "./job-store.ts";
export { RunStore } from "./run-store.ts";
export { SqliteHttpCache } from "./sqlite-http-cache.ts";
export { SqliteTabStore } from "./sqlite-tab-store.ts";
export { encodeCursor, decodeCursor } from "./cursor.ts";
export * from "./read-models.ts";
export type { JobRow, ProductRow, PriceRow, ImageRow, ImageSourceRow } from "./rows.ts";
