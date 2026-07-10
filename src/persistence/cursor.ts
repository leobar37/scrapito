import { ScrapError } from "../domain/errors.ts";

/** Encode a numeric id as an opaque base64url cursor. */
export function encodeCursor(id: number): string {
  return Buffer.from(String(id), "utf8").toString("base64url");
}

/** Decode an opaque cursor to a numeric id, or throw INVALID_CURSOR. */
export function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const id = Number(decoded);
  if (!Number.isInteger(id) || id < 0) {
    throw new ScrapError("INVALID_CURSOR", "malformed cursor");
  }
  return id;
}
