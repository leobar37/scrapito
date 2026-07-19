/**
 * Offline HAR analyzer. Classifies every sanitized entry, groups JSON API
 * calls by (method, origin, path template), diffs query parameters across the
 * entries of each group to infer which parameters vary (search/category/page)
 * and which are constant, and emits ranked endpoint candidates.
 *
 * This is the comparator step: without ≥2 entries per template no pagination
 * hypothesis is produced — a single HAR page can show an endpoint but cannot
 * explain it.
 *
 * Input MUST already be sanitized (`discover sanitize`); the analyzer refuses
 * entries that still carry live sensitive header values.
 */
import { ScrapError } from "@scrapito/contracts";
import type { HarEntry, HarFile } from "./har-schema.ts";
import { headerNameIsSensitive, REDACTED } from "./sanitize.ts";

export interface PaginationHypothesis {
  kind: "page" | "offset-range" | "cursor";
  parameters: string[];
}

export interface EndpointCandidate {
  method: string;
  origin: string;
  pathTemplate: string;
  responseMimeType: string;
  requestCount: number;
  /** Same value in every observed request. */
  constantParams: Record<string, string>;
  /** ≥2 distinct observed values, sampled to 5. */
  varyingParams: Record<string, string[]>;
  pagination: PaginationHypothesis | null;
  /** Relative artifact path of the sanitized sample response body. */
  sampleArtifact: string | null;
  productLikeKeys: string[];
  confidence: number;
}

export interface CandidateSample {
  name: string;
  body: string;
}

export interface AnalysisResult {
  candidates: EndpointCandidate[];
  samples: CandidateSample[];
  stats: {
    entries: number;
    jsonEntries: number;
    documentEntries: number;
    assetEntries: number;
    groups: number;
  };
}

const PRODUCT_KEYS: Record<string, true> = {
  price: true, listprice: true, offerprice: true, sku: true, product: true,
  products: true, productname: true, brand: true, image: true, images: true,
  items: true, results: true, records: true, name: true, offers: true,
};

const PAGE_PARAM = /^(page|p|pageno|pageindex|currentpage|pag)$/i;
const OFFSET_FROM = /^(_?from|_?start|offset)$/i;
const OFFSET_TO = /^(_?to|_?end|limit|count)$/i;
const CURSOR_PARAM = /cursor|after|nexttoken|continuation/i;

/** Numeric-only path segments become `{n}` so detail/listing URLs group. */
function pathTemplateOf(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? "{n}" : seg))
    .join("/");
}

/** True when a body looks like catalog JSON: ≥2 product-ish keys at any depth
 * of the top-level object/array. */
function productLikeKeysOf(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PRODUCT_KEYS[k.toLowerCase()] === true) found.add(k.toLowerCase());
      if (Array.isArray(v)) v.slice(0, 3).forEach((item) => walk(item, depth + 1));
      else if (v !== null && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(parsed, 0);
  return [...found].sort();
}

function inferPagination(varying: Record<string, string[]>): PaginationHypothesis | null {
  const names = Object.keys(varying);
  const page = names.find((n) => PAGE_PARAM.test(n) && varying[n]?.every((v) => /^\d+$/.test(v)));
  if (page) return { kind: "page", parameters: [page] };
  const from = names.find((n) => OFFSET_FROM.test(n) && varying[n]?.every((v) => /^\d+$/.test(v)));
  const to = names.find((n) => OFFSET_TO.test(n));
  if (from && to) return { kind: "offset-range", parameters: [from, to] };
  const cursor = names.find((n) => CURSOR_PARAM.test(n));
  if (cursor) return { kind: "cursor", parameters: [cursor] };
  return null;
}

/** Refuse to analyze evidence that still contains live sensitive values. */
function assertSanitized(entries: readonly HarEntry[]): void {
  for (const entry of entries) {
    for (const h of [...entry.request.headers, ...entry.response.headers]) {
      if (headerNameIsSensitive(h.name) && h.value !== REDACTED) {
        throw new ScrapError(
          "HAR_NOT_SANITIZED",
          `sensitive header "${h.name}" still has a live value; run \`discover sanitize\` first`,
        );
      }
    }
  }
}

function mimeOf(entry: HarEntry): string {
  return (entry.response.content?.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isAssetMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("font/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "text/css" ||
    mime.includes("javascript")
  );
}

/** Analyze a sanitized HAR into ranked endpoint candidates + sample bodies.
 * Deterministic: groups are processed in first-seen order, samples are the
 * first body per group, so re-running on the same HAR is byte-identical. */
export function analyzeHar(har: HarFile): AnalysisResult {
  const entries = har.log.entries;
  assertSanitized(entries);

  let jsonEntries = 0;
  let documentEntries = 0;
  let assetEntries = 0;
  const groups = new Map<string, HarEntry[]>();
  for (const entry of entries) {
    const mime = mimeOf(entry);
    if (isAssetMime(mime)) {
      assetEntries++;
      continue;
    }
    if (mime === "text/html") {
      documentEntries++;
      continue;
    }
    if (!mime.includes("json")) continue;
    jsonEntries++;
    let origin: string;
    let pathname: string;
    try {
      const u = new URL(entry.request.url);
      origin = u.origin;
      pathname = u.pathname;
    } catch {
      continue;
    }
    const key = `${entry.request.method.toUpperCase()} ${origin}${pathTemplateOf(pathname)}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const candidates: EndpointCandidate[] = [];
  const samples: CandidateSample[] = [];
  for (const [key, group] of groups) {
    const first = group[0]!;
    const [method, ...rest] = key.split(" ");
    const originAndPath = rest.join(" ");
    const origin = new URL(first.request.url).origin;
    const pathTemplate = originAndPath.slice(origin.length);

    const valuesByParam = new Map<string, string[]>();
    for (const entry of group) {
      const u = new URL(entry.request.url);
      for (const [name, value] of u.searchParams) {
        const values = valuesByParam.get(name) ?? [];
        if (!values.includes(value) && values.length < 5) values.push(value);
        valuesByParam.set(name, values);
      }
    }
    const constantParams: Record<string, string> = {};
    const varyingParams: Record<string, string[]> = {};
    for (const [name, values] of valuesByParam) {
      if (values.length <= 1) constantParams[name] = values[0] ?? "";
      else varyingParams[name] = values;
    }

    let sampleArtifact: string | null = null;
    let productLikeKeys: string[] = [];
    const sampleEntry = group.find((e) => (e.response.content?.text?.length ?? 0) > 0);
    const body = sampleEntry?.response.content?.text;
    if (body !== undefined) {
      productLikeKeys = productLikeKeysOf(body);
      sampleArtifact = `samples/${String(samples.length).padStart(3, "0")}.response.json`;
      samples.push({ name: sampleArtifact, body });
    }

    const pagination = inferPagination(varyingParams);
    let confidence = 0.4;
    if (productLikeKeys.length >= 2) confidence += 0.2;
    if (pagination) confidence += 0.15;
    if (method === "GET") confidence += 0.15;
    if (group.length >= 2) confidence += 0.1;

    candidates.push({
      method: method ?? "GET",
      origin,
      pathTemplate,
      responseMimeType: mimeOf(first) || "application/json",
      requestCount: group.length,
      constantParams,
      varyingParams,
      pagination,
      sampleArtifact,
      productLikeKeys,
      confidence: Math.min(0.99, Number(confidence.toFixed(2))),
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.pathTemplate.localeCompare(b.pathTemplate));
  return {
    candidates,
    samples,
    stats: {
      entries: entries.length,
      jsonEntries,
      documentEntries,
      assetEntries,
      groups: groups.size,
    },
  };
}

/** Candidates file written next to the sanitized HAR. */
export interface CandidatesFile {
  schemaVersion: 1;
  generatedAt: string;
  sourceHar: string;
  stats: AnalysisResult["stats"];
  candidates: EndpointCandidate[];
}
