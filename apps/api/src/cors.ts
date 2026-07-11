/**
 * Strict CORS: only GET/HEAD/OPTIONS are ever served (the API is physically
 * read-only), and only an EXACT configured origin gets
 * `Access-Control-Allow-Origin`. Requests without an `Origin` header (SSR,
 * CLI, curl) are always allowed through — CORS is a browser-only concept.
 * A browser request/preflight from a disallowed origin gets 403. No wildcard,
 * no reflection of arbitrary origins.
 */
import type { Context, Next } from "hono";

export function strictCors(allowedOrigins: readonly string[]) {
  return async (c: Context, next: Next) => {
    const origin = c.req.header("origin");

    if (c.req.method === "OPTIONS") {
      if (!origin) return c.body(null, 204);
      if (!allowedOrigins.includes(origin)) return c.text("Forbidden", 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }

    if (origin) {
      if (!allowedOrigins.includes(origin)) return c.text("Forbidden", 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    await next();
  };
}
