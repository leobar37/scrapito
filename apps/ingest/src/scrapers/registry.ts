/**
 * Static scraper registry. Durable, reviewed runtime scrapers are imported here
 * at build time. The server accepts ONLY a registered scraper id plus that
 * scraper's Zod-validated params — never source code, module paths, or URLs.
 * This module MUST NOT import anything under `src/discovery/**`.
 */
import type { Scraper } from "./define-scraper.ts";
import { ripleyProductsScraper } from "./ripley-pe/products.ts";
import { falabellaProductsScraper } from "./falabella-pe/products.ts";
import { promartProductsScraper } from "./promart-pe/products.ts";
import { fixtureProductsScraper } from "./fixture-products.ts";

const REGISTERED: readonly Scraper[] = [
  ripleyProductsScraper,
  falabellaProductsScraper,
  promartProductsScraper,
  fixtureProductsScraper,
];

const BY_ID = new Map<string, Scraper>();
for (const scraper of REGISTERED) {
  if (BY_ID.has(scraper.id)) {
    throw new Error(`duplicate scraper id registered: ${scraper.id}`);
  }
  BY_ID.set(scraper.id, scraper);
}

export function getScraper(id: string): Scraper | undefined {
  return BY_ID.get(id);
}

export function listScrapers(): readonly Scraper[] {
  return REGISTERED;
}

export function hasScraper(id: string): boolean {
  return BY_ID.has(id);
}
