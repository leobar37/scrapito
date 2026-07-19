#!/usr/bin/env bun
/**
 * Production web entry: the TanStack Start server bundle (dist/server/server.js)
 * renders SSR but does NOT serve the built client assets. This thin front server
 * serves everything under dist/client as static files and proxies every other
 * request (SSR pages, loaders) to the SSR server running on an internal port.
 *
 *   SSR_ORIGIN  internal SSR server origin (default http://127.0.0.1:3002)
 *   PORT        public port (default 3001)
 *   HOST        public bind host (default 0.0.0.0)
 */
import { join, normalize } from "node:path";

const CLIENT_DIR = join(import.meta.dir, "dist", "client");
const SSR_ORIGIN = process.env.SSR_ORIGIN ?? "http://127.0.0.1:3002";
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // Serve a real file from dist/client (assets, favicon, etc.) — never the root.
    if (url.pathname !== "/") {
      const rel = normalize(url.pathname).replace(/^(?:\.\.[/\\])+/, "");
      const filePath = join(CLIENT_DIR, rel);
      if (filePath.startsWith(CLIENT_DIR)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file, {
            headers: url.pathname.startsWith("/assets/")
              ? { "cache-control": "public, max-age=31536000, immutable" }
              : {},
          });
        }
      }
    }

    // Everything else → SSR server.
    const target = SSR_ORIGIN + url.pathname + url.search;
    const headers = new Headers(req.headers);
    headers.set("host", new URL(SSR_ORIGIN).host);
    return fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
  },
});

console.log(`prod web listening on http://${HOST}:${PORT} (static=${CLIENT_DIR}, ssr=${SSR_ORIGIN})`);
