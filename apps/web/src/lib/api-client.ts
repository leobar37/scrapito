/**
 * Typed HTTP client for the Hono read-only API. Every response is
 * runtime-validated against its Zod schema; a non-2xx response is mapped to
 * `ApiError` (parsed against `ApiErrorSchema` when possible). Image DTO paths
 * are API-relative and must be resolved against `apiBaseUrl()` before
 * rendering — see `resolveImageUrl`.
 */
import type { z } from "zod";
import { ApiErrorSchema } from "@scrapito/contracts";
import { apiBaseUrl } from "../env.ts";

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiGet<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const base = apiBaseUrl();
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, { ...init, method: "GET" });
  const body: unknown = await res.json().catch(() => undefined);

  if (!res.ok) {
    const parsedError = ApiErrorSchema.safeParse(body);
    if (parsedError.success) {
      throw new ApiRequestError(res.status, parsedError.data.error.code, parsedError.data.error.message, parsedError.data.error.details);
    }
    throw new ApiRequestError(res.status, "UNKNOWN", `request to ${path} failed with status ${res.status}`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError(res.status, "INVALID_RESPONSE", `response from ${path} failed schema validation`, parsed.error.issues);
  }
  return parsed.data;
}

/** Resolve an API-relative image DTO path (e.g. `/images/<sha256>`) against
 * the current execution context's API base. */
export function resolveImageUrl(relativeOrAbsolute: string | null): string | null {
  if (!relativeOrAbsolute) return null;
  if (relativeOrAbsolute.startsWith("http")) return relativeOrAbsolute;
  return `${apiBaseUrl()}${relativeOrAbsolute}`;
}
