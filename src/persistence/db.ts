/**
 * SQLite connection (bun:sqlite) in WAL mode with foreign keys and a busy
 * timeout, plus an ordered checked-in migration runner tracked in `_migrations`.
 * Server and worker refuse to start with pending/failed migrations.
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function openDatabase(path: string): Database {
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

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
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
