#!/usr/bin/env bun
/** `bun run db:migrate` — apply pending migrations to SCRAP_DB_PATH (idempotent). */
import { join } from "node:path";
import { openWriterDatabase, runMigrations } from "./db.ts";

const dbPath = process.env.SCRAP_DB_PATH ?? join(process.cwd(), "data", "scrap.sqlite");
const db = openWriterDatabase(dbPath);
const result = runMigrations(db);
console.log(JSON.stringify({ applied: result.applied, alreadyApplied: result.alreadyApplied }));
db.close();
