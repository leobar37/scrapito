/**
 * `defineScraper(spec)` — the public authoring contract that generated scripts
 * and store implementations must obey. Validates the spec shape, immutable slug,
 * positive integer version, allowlisted match patterns, and default budgets.
 * Remote callers may only lower the declared limits.
 */
import { z } from "zod";
import { StoreIdSchema, type StoreId } from "../domain/ids.ts";
import { ScrapError } from "../domain/errors.ts";
import { isHostAllowed } from "../policy/allowlist.ts";
import type { ScrapeFn, ScrapeContext } from "./context.ts";
import type { ProductInput } from "../domain/schemas.ts";

export interface ScraperDefaults {
  maxRequests: number;
  maxDurationMs: number;
  downloadImages: boolean;
}

export interface ScraperSpec<Params> {
  id: string;
  store: StoreId;
  version: number;
  /** Allowlisted store URL patterns this scraper is permitted to target. */
  match: string[];
  paramsSchema: z.ZodType<Params>;
  defaults?: Partial<ScraperDefaults>;
  /** Offline self-check: normalize checked-in fixtures into validated products. */
  selfCheck?: () => ProductInput[];
  scrape: ScrapeFn<Params>;
}

export interface Scraper {
  readonly id: string;
  readonly store: StoreId;
  readonly version: number;
  readonly match: readonly string[];
  readonly paramsSchema: z.ZodType<unknown>;
  readonly defaults: ScraperDefaults;
  readonly selfCheck?: () => ProductInput[];
  readonly scrape: ScrapeFn<unknown>;
}

const DEFAULT_DEFAULTS: ScraperDefaults = {
  maxRequests: 500,
  maxDurationMs: 1_800_000,
  downloadImages: true,
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertAllowlistedPattern(pattern: string): void {
  // Each match pattern must be a URL (or URL prefix) on an allowlisted host.
  let host: string;
  try {
    host = new URL(pattern).hostname;
  } catch {
    throw new ScrapError("INVALID_MATCH", `match pattern is not a valid URL: ${pattern}`);
  }
  if (!isHostAllowed(host)) {
    throw new ScrapError("INVALID_MATCH", `match pattern host is not allowlisted: ${host}`);
  }
}

export function defineScraper<Params>(spec: ScraperSpec<Params>): Scraper {
  if (!SLUG.test(spec.id)) {
    throw new ScrapError("INVALID_SCRAPER", `scraper id must be a slug: ${spec.id}`);
  }
  StoreIdSchema.parse(spec.store);
  if (!Number.isInteger(spec.version) || spec.version <= 0) {
    throw new ScrapError("INVALID_SCRAPER", `version must be a positive integer: ${spec.version}`);
  }
  if (!Array.isArray(spec.match) || spec.match.length === 0) {
    throw new ScrapError("INVALID_SCRAPER", "match must be a non-empty array");
  }
  for (const pattern of spec.match) assertAllowlistedPattern(pattern);

  const defaults: ScraperDefaults = { ...DEFAULT_DEFAULTS, ...spec.defaults };
  if (defaults.maxRequests <= 0 || defaults.maxDurationMs <= 0) {
    throw new ScrapError("INVALID_SCRAPER", "default budgets must be positive");
  }

  return Object.freeze({
    id: spec.id,
    store: spec.store,
    version: spec.version,
    match: Object.freeze([...spec.match]),
    paramsSchema: spec.paramsSchema as z.ZodType<unknown>,
    defaults,
    selfCheck: spec.selfCheck,
    scrape: (ctx: ScrapeContext<unknown>) => spec.scrape(ctx as ScrapeContext<Params>),
  });
}

/** Match a URL against a scraper's patterns (prefix match on canonical URL). */
export function scraperMatches(scraper: Scraper, url: string): boolean {
  return scraper.match.some((p) => url.startsWith(p) || url === p);
}
