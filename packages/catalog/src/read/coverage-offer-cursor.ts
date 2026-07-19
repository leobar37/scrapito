import { ScrapError } from "@scrapito/contracts";

export interface CoverageOfferCursorKey {
  coverageId: number;
  productId: number;
  sightingId: number;
}

export function encodeCoverageOfferCursor(key: CoverageOfferCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, ...key }), "utf8").toString("base64url");
}

export function decodeCoverageOfferCursor(cursor: string, coverageId: number): CoverageOfferCursorKey {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      raw.v !== 1 ||
      !Number.isInteger(raw.coverageId) ||
      !Number.isInteger(raw.productId) ||
      !Number.isInteger(raw.sightingId) ||
      Number(raw.coverageId) <= 0 ||
      Number(raw.productId) <= 0 ||
      Number(raw.sightingId) <= 0
    ) {
      throw new Error("invalid key");
    }
    if (raw.coverageId !== coverageId) {
      throw new ScrapError("INVALID_CURSOR", "cursor belongs to a different coverage");
    }
    return {
      coverageId: Number(raw.coverageId),
      productId: Number(raw.productId),
      sightingId: Number(raw.sightingId),
    };
  } catch (error) {
    if (error instanceof ScrapError) throw error;
    throw new ScrapError("INVALID_CURSOR", "malformed coverage offer cursor");
  }
}
