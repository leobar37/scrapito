/**
 * SQLite connection (bun:sqlite) in WAL mode with foreign keys and a busy
 * timeout, plus an ordered checked-in migration runner tracked in `_migrations`.
 * ONLY the write side may create the database, run migrations, or issue
 * PRAGMA writes — the read side opens an existing file readonly and never
 * touches schema.
 */
import { Database } from "bun:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS_DIR, listMigrationFiles } from "../migrations-list.ts";

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function openWriterDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  assertFts5(db);
  return db;
}

/** Verify FTS5 is available; fail fast with a clear prerequisite error. */
function assertFts5(db: Database): void {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x);");
    db.exec("DROP TABLE IF EXISTS _fts5_probe;");
  } catch (err) {
    throw new Error(
      "SQLite FTS5 is required but unavailable in this build: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function ensureMigrationsTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`,
  );
}


/** Apply pending migrations in filename order. Idempotent. */
export function runMigrations(db: Database): MigrationResult {
  ensureMigrationsTable(db);
  const appliedRows = db.query("SELECT name FROM _migrations").all() as { name: string }[];
  const done = new Set(appliedRows.map((r) => r.name));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of listMigrationFiles()) {
    if (done.has(file)) {
      alreadyApplied.push(file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO _migrations(name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    tx();
    applied.push(file);
  }
  return { applied, alreadyApplied };
}

/** True when every checked-in migration has been applied. */
export function migrationsPending(db: Database): boolean {
  ensureMigrationsTable(db);
  const appliedRows = db.query("SELECT name FROM _migrations").all() as { name: string }[];
  const done = new Set(appliedRows.map((r) => r.name));
  return listMigrationFiles().some((f) => !done.has(f));
}
