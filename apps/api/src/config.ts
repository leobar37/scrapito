/** Central runtime configuration for the read-only API. No scraping/ingestion
 * fields here — those live in apps/ingest/src/config.ts. */
import { join } from "node:path";

export interface ApiConfig {
  dbPath: string;
  storageDir: string;
  host: string;
  port: number;
  /** Explicit opt-in required to bind a non-loopback host. */
  publicReads: boolean;
  /** Comma-separated exact origins allowed for browser CORS (GET/HEAD/OPTIONS only). */
  webOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const root = process.cwd();
  return {
    dbPath: env.SCRAP_DB_PATH ?? join(root, "data", "scrap.sqlite"),
    storageDir: env.SCRAP_STORAGE_DIR ?? join(root, "storage"),
    host: env.SCRAP_HOST ?? "127.0.0.1",
    port: env.SCRAP_PORT ? Number(env.SCRAP_PORT) : 3000,
    publicReads: env.SCRAP_PUBLIC_READS === "true",
    webOrigins: (env.WEB_ORIGIN ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
