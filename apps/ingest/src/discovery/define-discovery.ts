/**
 * Discovery authoring API. Discovery definitions are imported ONLY by the local
 * `scrap discover` entrypoint — never by `src/scrapers/registry.ts` or the Hono
 * server — so discovery-only `BrowserTab.evaluate` stays out of the server graph.
 */
import type { StoreId } from "@scrapito/contracts";
import type { BrowserSession } from "../browser/browser-manager.ts";
import type { CrawlPolicy } from "../policy/crawl-policy.ts";
import type { Logger } from "../util/logger.ts";

export interface DiscoveryArtifacts {
  /** Absolute directory `data/discovery/<run-id>/` for this discovery run. */
  readonly dir: string;
  /** Persist a text/binary artifact (HTML, HAR, screenshot bytes, candidate). */
  save(name: string, content: string | Uint8Array): string;
  /** Persist a JSON artifact (request summaries, sampled payloads). */
  saveJson(name: string, data: unknown): string;
}

export interface DiscoveryContext {
  browser: BrowserSession;
  policy: CrawlPolicy;
  artifacts: DiscoveryArtifacts;
  logger: Logger;
}

export type DiscoveryFn = (ctx: DiscoveryContext) => Promise<void>;

export interface DiscoverySpec {
  scraperId: string;
  store: StoreId;
  run: DiscoveryFn;
}

export interface Discovery {
  readonly scraperId: string;
  readonly store: StoreId;
  readonly run: DiscoveryFn;
}

export function defineDiscovery(spec: DiscoverySpec): Discovery {
  return Object.freeze({ scraperId: spec.scraperId, store: spec.store, run: spec.run });
}
