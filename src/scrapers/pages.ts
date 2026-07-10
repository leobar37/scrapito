import type { Pages } from "../domain/schemas.ts";

/** Expand a page selection into an explicit ascending list of page numbers. */
export function resolvePages(pages: Pages | undefined): number[] {
  if (pages === undefined) return [1];
  if (typeof pages === "number") return [pages];
  if (Array.isArray(pages)) return [...pages].sort((a, b) => a - b);
  const out: number[] = [];
  for (let p = pages.from; p <= pages.to; p++) out.push(p);
  return out;
}
