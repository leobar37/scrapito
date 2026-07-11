/**
 * Dedicated versioned keyset cursor for `/offers`. Encodes a SHA-256
 * fingerprint of the normalized search input (excluding cursor/limit) plus
 * the sort-specific keyset tuple. Reject wrong version/fingerprint/type,
 * cursor length over 2 KiB, or a changed filter/query/sort.
 */
import { createHash } from "node:crypto";
import { ScrapError, type OfferSearchInput, type OfferSort } from "@scrapito/contracts";

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;

export type OfferCursorKey =
  | { sort: "relevance"; rank: number; productId: number }
  | { sort: "discount_desc"; discountBps: number; productId: number }
  | { sort: "price_asc" | "price_desc"; effectiveCents: number; productId: number }
  | { sort: "updated_desc"; observedAtMs: number; productId: number };

interface OfferCursorPayload {
  v: number;
  fp: string;
  key: OfferCursorKey;
}

function normalizeForFingerprint(input: OfferSearchInput): string {
  const { cursor: _cursor, limit: _limit, ...rest } = input;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(rest).sort()) {
    const value = (rest as Record<string, unknown>)[key];
    normalized[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return JSON.stringify(normalized);
}

export function fingerprintOfferSearch(input: OfferSearchInput): string {
  return createHash("sha256").update(normalizeForFingerprint(input)).digest("hex");
}

export function encodeOfferCursor(input: OfferSearchInput, key: OfferCursorKey): string {
  const payload: OfferCursorPayload = { v: CURSOR_VERSION, fp: fingerprintOfferSearch(input), key };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throw new ScrapError("INTERNAL", "encoded offer cursor exceeds maximum length");
  }
  return encoded;
}

export function decodeOfferCursor(cursor: string, input: OfferSearchInput, sort: OfferSort): OfferCursorKey {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new ScrapError("INVALID_CURSOR", "cursor exceeds maximum length");
  }
  let payload: OfferCursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as OfferCursorPayload;
  } catch {
    throw new ScrapError("INVALID_CURSOR", "malformed cursor");
  }
  if (!payload || typeof payload !== "object" || payload.v !== CURSOR_VERSION) {
    throw new ScrapError("INVALID_CURSOR", "unsupported cursor version");
  }
  if (payload.fp !== fingerprintOfferSearch(input)) {
    throw new ScrapError("INVALID_CURSOR", "cursor does not match the current filters/query/sort");
  }
  if (!payload.key || payload.key.sort !== sort) {
    throw new ScrapError("INVALID_CURSOR", "cursor sort mismatch");
  }
  return payload.key;
}
