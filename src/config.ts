/**
 * Central runtime configuration read from environment variables. Keeping this
 * in one place lets the CLI, server, worker, and tests share the same defaults.
 */
import { join } from "node:path";

export interface AppConfig {
  dbPath: string;
  storageDir: string;
  discoveryDir: string;
  userAgent: string | undefined;
  apiKey: string | undefined;
  host: string;
  port: number;
  agentBrowserBin: string;
  agentBrowserTimeoutMs: number;
  workerIdleTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 25_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = process.cwd();
  return {
    dbPath: env.SCRAP_DB_PATH ?? join(root, "data", "scrap.sqlite"),
    storageDir: env.SCRAP_STORAGE_DIR ?? join(root, "storage"),
    discoveryDir: env.SCRAP_DISCOVERY_DIR ?? join(root, "data", "discovery"),
    userAgent: env.SCRAP_USER_AGENT,
    apiKey: env.SCRAP_API_KEY,
    host: env.SCRAP_HOST ?? "127.0.0.1",
    port: env.SCRAP_PORT ? Number(env.SCRAP_PORT) : 3000,
    agentBrowserBin:
      env.AGENT_BROWSER_BIN ?? join(root, "node_modules", ".bin", "agent-browser"),
    agentBrowserTimeoutMs: env.AGENT_BROWSER_DEFAULT_TIMEOUT
      ? Number(env.AGENT_BROWSER_DEFAULT_TIMEOUT)
      : DEFAULT_TIMEOUT_MS,
    workerIdleTimeoutMs: env.SCRAP_WORKER_IDLE_TIMEOUT
      ? Number(env.SCRAP_WORKER_IDLE_TIMEOUT)
      : 20_000,
  };
}
