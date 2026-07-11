/**
 * Read-only SQLite connection. Opens an EXISTING database file with
 * `readonly: true, create: false` and performs ONLY read queries to verify
 * schema/migration state — never a migration, `PRAGMA journal_mode`, an FTS5
 * probe, `_migrations` table creation, or any other write. A missing file or
 * pending migrations both fail startup without touching the file.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { listMigrationFiles } from "../migrations-list.ts";

export class CatalogDatabaseNotFoundError extends Error {
  constructor(path: string) {
    super(`catalog database not found at ${path}; run the ingest CLI's db:migrate first`);
  }
}

export class CatalogMigrationsPendingError extends Error {
  constructor() {
    super("catalog database has pending migrations; run `bun run db:migrate` (write side)");
  }
}

export function openReaderDatabase(path: string): Database {
  if (path !== ":memory:" && !existsSync(path)) {
    throw new CatalogDatabaseNotFoundError(path);
  }
  return new Database(path, { readonly: true, create: false });
}

/** True when at least one checked-in migration has not been applied, or the
 * `_migrations` table itself doesn't exist yet (never migrated). Read-only:
 * a missing `_migrations` table is detected via a SELECT failure, never
 * created. */
export function readerMigrationsPending(db: Database): boolean {
  let done: Set<string>;
  try {
    const rows = db.query("SELECT name FROM _migrations").all() as { name: string }[];
    done = new Set(rows.map((r) => r.name));
  } catch {
    return true;
  }
  return listMigrationFiles().some((f) => !done.has(f));
}
