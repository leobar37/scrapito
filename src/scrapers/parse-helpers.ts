/** Safe accessors for parsing untyped SSR/JSON-LD payloads (guarded, no `any`). */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Walk a dotted path through nested records/arrays, returning unknown. */
export function dig(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split(".")) {
    if (Array.isArray(node)) {
      const idx = Number(key);
      node = Number.isInteger(idx) ? node[idx] : undefined;
    } else {
      const rec = asRecord(node);
      node = rec ? rec[key] : undefined;
    }
    if (node === undefined) return undefined;
  }
  return node;
}
