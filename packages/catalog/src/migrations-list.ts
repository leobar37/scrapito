/** Pure filesystem listing of checked-in migrations — no bun:sqlite, no
 * writes. Shared by the write-side runner and the read-side pending check. */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}
