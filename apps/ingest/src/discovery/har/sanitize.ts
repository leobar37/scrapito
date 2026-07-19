/**
 * Offline HAR sanitizer. A captured HAR contains live cookies, auth headers,
 * CSRF tokens and signed query parameters; none of that may reach an external
 * agent or a checked-in fixture. This module produces `network.sanitized.har`:
 *
 *  - entries restricted to allowlisted store hosts (analytics/tracker traffic
 *    on third-party hosts is dropped entirely);
 *  - sensitive header / cookie values replaced with "[REDACTED]";
 *  - sensitive query parameter values redacted BOTH in `request.url` and in
 *    `request.queryString` (kept consistent so diffing still works);
 *  - POST bodies deep-redacted by key when parseable JSON, dropped otherwise;
 *  - base64-encoded response bodies dropped, large text bodies truncated.
 *
 * Redaction is deliberately over-broad: losing a benign parameter is fine,
 * leaking a credential is not.
 */
import { isHostAllowed } from "../../policy/allowlist.ts";
import type { HarEntry, HarFile, HarNameValue } from "./har-schema.ts";

export const REDACTED = "[REDACTED]";

const SENSITIVE_HEADER_EXACT: Record<string, true> = {
  "cookie": true,
  "set-cookie": true,
  "authorization": true,
  "proxy-authorization": true,
  "x-csrf-token": true,
  "x-xsrf-token": true,
  "x-api-key": true,
  "x-access-token": true,
  "x-id-token": true,
  "x-device-id": true,
};
const SENSITIVE_NAME = /token|secret|session|signature|credential|fingerprint/i;
const SENSITIVE_PARAM = /token|secret|session|signature|sig|nonce|api[-_]?key|access[-_]?key|auth|code|state/i;

/** Hard cap on any response body kept in the sanitized HAR. */
export const MAX_BODY_CHARS = 200_000;
export const TRUNCATED_MARKER = "\n…[TRUNCATED BY SANITIZER]";

export interface SanitizeStats {
  entries: number;
  kept: number;
  droppedForeignHost: number;
  redactedHeaders: number;
  redactedParams: number;
  redactedPostData: number;
  droppedEncodedBodies: number;
  truncatedBodies: number;
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_EXACT[lower] === true || SENSITIVE_NAME.test(lower);
}

function redactHeaders(headers: HarNameValue[], stats: SanitizeStats): HarNameValue[] {
  return headers.map((h) => {
    if (h.value !== REDACTED && isSensitiveHeader(h.name)) {
      stats.redactedHeaders++;
      return { ...h, value: REDACTED };
    }
    return h;
  });
}

/** Redact sensitive keys at any depth of a parsed JSON payload. Returns the
 * redacted value, or undefined when the input is not parseable JSON. */
function redactJsonDeep(value: unknown, stats: SanitizeStats): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJsonDeep(v, stats));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_PARAM.test(k)) {
        stats.redactedParams++;
        out[k] = REDACTED;
      } else {
        out[k] = redactJsonDeep(v, stats);
      }
    }
    return out;
  }
  return value;
}

/** Redact sensitive query params in a URL string; unparseable URLs are
 * returned untouched (they will be dropped by the host filter anyway). */
function redactUrl(rawUrl: string, stats: SanitizeStats): string {
  try {
    const u = new URL(rawUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key) && u.searchParams.get(key) !== REDACTED) {
        u.searchParams.set(key, REDACTED);
        stats.redactedParams++;
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeEntry(entry: HarEntry, stats: SanitizeStats): HarEntry {
  const request: HarEntry["request"] = {
    ...entry.request,
    url: redactUrl(entry.request.url, stats),
    headers: redactHeaders(entry.request.headers, stats),
    queryString: entry.request.queryString.map((p) => {
      if (p.value !== REDACTED && SENSITIVE_PARAM.test(p.name)) {
        stats.redactedParams++;
        return { ...p, value: REDACTED };
      }
      return p;
    }),
    cookies: [],
  };
  if (request.postData?.text !== undefined) {
    const raw = request.postData.text;
    let sanitized: string;
    try {
      sanitized = JSON.stringify(redactJsonDeep(JSON.parse(raw), stats));
      stats.redactedPostData++;
    } catch {
      sanitized = REDACTED;
      stats.redactedPostData++;
    }
    request.postData = { ...request.postData, text: sanitized.slice(0, 8192) };
  }

  const response: HarEntry["response"] = {
    ...entry.response,
    headers: redactHeaders(entry.response.headers, stats),
    cookies: [],
  };
  const content = response.content;
  if (content?.text !== undefined) {
    if (content.encoding && content.encoding !== "") {
      // Encoded (usually base64) bodies cannot be inspected for secrets: drop.
      response.content = { ...content, text: undefined };
      stats.droppedEncodedBodies++;
    } else if (content.text.length > MAX_BODY_CHARS) {
      response.content = {
        ...content,
        text: content.text.slice(0, MAX_BODY_CHARS) + TRUNCATED_MARKER,
      };
      stats.truncatedBodies++;
    }
  }
  return { ...entry, request, response };
}

/** Produce a sanitized copy of `har` plus redaction/drop statistics. The
 * input object is never mutated. */
export function sanitizeHar(har: HarFile): { har: HarFile; stats: SanitizeStats } {
  const stats: SanitizeStats = {
    entries: har.log.entries.length,
    kept: 0,
    droppedForeignHost: 0,
    redactedHeaders: 0,
    redactedParams: 0,
    redactedPostData: 0,
    droppedEncodedBodies: 0,
    truncatedBodies: 0,
  };
  const entries: HarEntry[] = [];
  for (const entry of har.log.entries) {
    let host: string;
    try {
      host = new URL(entry.request.url).hostname;
    } catch {
      stats.droppedForeignHost++;
      continue;
    }
    if (!isHostAllowed(host)) {
      stats.droppedForeignHost++;
      continue;
    }
    entries.push(sanitizeEntry(entry, stats));
    stats.kept++;
  }
  return { har: { ...har, log: { ...har.log, entries } }, stats };
}

/** Names considered sensitive; exported so the verifier can assert none of
 * them survive sanitization with a live value. */
export function headerNameIsSensitive(name: string): boolean {
  return isSensitiveHeader(name);
}

export function paramNameIsSensitive(name: string): boolean {
  return SENSITIVE_PARAM.test(name);
}
