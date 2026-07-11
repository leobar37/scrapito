/**
 * Server startup. Binds 127.0.0.1:3000 by default. Any non-loopback IPv4/IPv6
 * bind requires strict `SCRAP_PUBLIC_READS=true`, otherwise startup fails
 * without binding anything. Opening the reader against a missing or
 * pending-migration database also fails startup without creating/migrating
 * the file (see @scrapito/catalog/read).
 */
import { openCatalogReader, type CatalogReader } from "@scrapito/catalog/read";
import type { ApiConfig } from "./config.ts";
import { createServer } from "./app.ts";

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

export interface ServeHandle {
  port: number;
  hostname: string;
  reader: CatalogReader;
  stop(): void;
}

export function startServer(config: ApiConfig, overrides: { host?: string; port?: number } = {}): ServeHandle {
  const host = overrides.host ?? config.host;
  const port = overrides.port ?? config.port;
  if (!LOOPBACK[host] && !config.publicReads) {
    throw new Error(
      "refusing to bind a non-loopback host without SCRAP_PUBLIC_READS=true (explicit opt-in required)",
    );
  }
  const reader = openCatalogReader(config.dbPath);
  const server = createServer(reader, config);
  const bun = Bun.serve({ port, hostname: host, fetch: server.fetch });
  return {
    port: bun.port,
    hostname: host,
    reader,
    stop: () => {
      bun.stop(true);
      reader.close();
    },
  };
}
