/**
 * Central runtime configuration for the ingestion CLI, read from environment
 * variables. The API has its own config (apps/api/src/config.ts) — ingestion
 * never reads/serves HTTP.
 */
import { join } from "node:path";

export interface IngestConfig {
  dbPath: string;
  storageDir: string;
  discoveryDir: string;
  userAgent: string | undefined;
  agentBrowserBin: string;
  agentBrowserTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 25_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const root = process.cwd();
  return {
    dbPath: env.SCRAP_DB_PATH ?? join(root, "data", "scrap.sqlite"),
    storageDir: env.SCRAP_STORAGE_DIR ?? join(root, "storage"),
    discoveryDir: env.SCRAP_DISCOVERY_DIR ?? join(root, "data", "discovery"),
    userAgent: env.SCRAP_USER_AGENT,
    agentBrowserBin: env.AGENT_BROWSER_BIN ?? join(root, "node_modules", ".bin", "agent-browser"),
    agentBrowserTimeoutMs: env.AGENT_BROWSER_DEFAULT_TIMEOUT
      ? Number(env.AGENT_BROWSER_DEFAULT_TIMEOUT)
      : DEFAULT_TIMEOUT_MS,
  };
}
