/**
 * Server startup. Binds 127.0.0.1:3000 by default and refuses to bind a
 * non-loopback host when SCRAP_API_KEY is unset (read routes are public).
 */
import type { AppServices } from "../app/services.ts";
import { createServer } from "./app.ts";

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, localhost: true };

export interface ServeHandle {
  port: number;
  hostname: string;
  stop(): void;
}

export function startServer(app: AppServices, overrides: { host?: string; port?: number } = {}): ServeHandle {
  const host = overrides.host ?? app.config.host;
  const port = overrides.port ?? app.config.port;
  if (!LOOPBACK[host] && !app.config.apiKey) {
    throw new Error(
      "refusing to bind a non-loopback host without SCRAP_API_KEY set (read routes are public)",
    );
  }
  const server = createServer(app);
  const bun = Bun.serve({ port, hostname: host, fetch: server.fetch });
  return {
    port: bun.port,
    hostname: host,
    stop: () => bun.stop(true),
  };
}
