/** Parse a PEN price into integer céntimos. Accepts numbers (soles) or strings. */
export function toCents(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    // Strip currency symbols/labels; keep digits, dot, comma.
    const cleaned = value.replace(/[^\d.,]/g, "");
    if (cleaned.length === 0) return null;
    // Peru format: thousands "," decimal "." -> "1,299.00".
    const normalized = cleaned.replace(/,/g, "");
    const num = Number(normalized);
    if (!Number.isFinite(num)) return null;
    return Math.round(num * 100);
  }
  return null;
}
