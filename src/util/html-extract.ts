/**
 * SSR extraction helpers shared by the browser layer and store scrapers.
 * Pure string parsing — no DOM, no eval.
 */

/** Extract and parse the `__NEXT_DATA__` JSON blob from a rendered HTML string. */
export function extractNextData<T = unknown>(html: string): T | undefined {
  const match = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match || match[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return undefined;
  }
}

/** Extract every `application/ld+json` block as parsed JSON (bad blocks skipped). */
export function extractJsonLd(html: string): unknown[] {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  const out: unknown[] = [];
  for (const m of html.matchAll(re)) {
    const raw = m[1];
    if (raw === undefined) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // skip malformed block
    }
  }
  return out;
}

/** Flatten JSON-LD, expanding @graph arrays, so callers can scan by @type. */
export function flattenJsonLd(blocks: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      out.push(obj);
      if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
    }
  };
  for (const b of blocks) visit(b);
  return out;
}

/** Find the first JSON-LD node whose @type is (or includes) `type`. */
export function findJsonLdByType(
  html: string,
  type: string,
): Record<string, unknown> | undefined {
  const nodes = flattenJsonLd(extractJsonLd(html));
  return nodes.find((n) => {
    const t = n["@type"];
    if (typeof t === "string") return t === type;
    if (Array.isArray(t)) return t.includes(type);
    return false;
  });
}
