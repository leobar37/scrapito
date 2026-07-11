/**
 * `API_BASE_URL` is read ONLY on the server (SSR loaders/server functions) and
 * must never be bundled for the browser. `VITE_PUBLIC_API_BASE_URL` is the
 * browser-visible base (Vite inlines `import.meta.env.VITE_*` at build time).
 * Both are required — missing either fails startup rather than silently
 * falling back to a guessed origin.
 */

export function serverApiBaseUrl(): string {
  const value = process.env.API_BASE_URL;
  if (!value) {
    throw new Error("API_BASE_URL must be set (server-only Hono API base, e.g. http://127.0.0.1:3000)");
  }
  return value.replace(/\/$/, "");
}

export function publicApiBaseUrl(): string {
  const value = import.meta.env.VITE_PUBLIC_API_BASE_URL as string | undefined;
  if (!value) {
    throw new Error("VITE_PUBLIC_API_BASE_URL must be set (browser-visible Hono API base)");
  }
  return value.replace(/\/$/, "");
}

/** The correct base for the current execution context (server vs browser). */
export function apiBaseUrl(): string {
  return typeof window === "undefined" ? serverApiBaseUrl() : publicApiBaseUrl();
}
