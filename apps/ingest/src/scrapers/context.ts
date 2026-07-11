/**
 * Runtime ScrapeContext handed to a registered scraper's `scrape(ctx)`.
 * `save.productSnapshot` is the ONLY public write; it validates each product
 * independently at the SDK boundary and rejects only the invalid product. Raw
 * SQLite, arbitrary subprocess execution, `eval`, and `new Function` are never
 * exposed here.
 */
import type { StoreId } from "@scrapito/contracts";
import type { ProductInput } from "@scrapito/contracts";
import type { FetchOptions, PolicyResponse } from "../policy/crawl-policy.ts";
import type { RequestBudget } from "../policy/budget.ts";
import type { Logger } from "../util/logger.ts";
import type { BrowserTab } from "../browser/browser-manager.ts";

export interface ScrapeHttp {
  /** Policy-controlled fetch. Rejects disallowed hosts/paths and enforces pacing. */
  fetch(url: string, options?: FetchOptions): Promise<PolicyResponse>;
}

export type SaveOutcome =
  | { ok: true; productId: number; created: boolean; priceInserted: boolean }
  | { ok: false; error: string };

export interface ScrapeSave {
  /** Validate + atomically commit one normalized product/category/price snapshot. */
  productSnapshot(input: unknown): SaveOutcome;
}

/** A fixed, code-reviewed browser recipe returning JSON-serializable data only. */
export type BrowserRecipe<T> = (tab: BrowserTab) => Promise<T>;

export interface ScrapeRun {
  id: number;
  store: StoreId;
  downloadImages: boolean;
}

export interface ScrapeContext<Params = Record<string, unknown>> {
  http: ScrapeHttp;
  /** Run an approved browser recipe for fields genuinely absent from SSR. */
  browserRecipe<T>(label: string, recipe: BrowserRecipe<T>): Promise<T>;
  save: ScrapeSave;
  logger: Logger;
  run: ScrapeRun;
  params: Params;
  budget: RequestBudget;
}

export interface ScrapeResultSummary {
  pagesProcessed: number;
  productsSeen: number;
}

export type ScrapeFn<Params> = (ctx: ScrapeContext<Params>) => Promise<ScrapeResultSummary | void>;

export type { ProductInput };
