/**
 * Oechsle Peru products scraper. Uses the VTEX catalog system search API
 * (/api/catalog_system/pub/products/search/…) — no browser required.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProductInput } from "@scrapito/contracts";
import { defineScraper } from "../define-scraper.ts";
import { resolvePages } from "../pages.ts";
import { normalizeOechsleSearchResults } from "./normalize.ts";

const BASE = "https://www.oechsle.pe";

const paramsSchema = z.object({
  search: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  urls: z.array(z.string().url()).optional(),
  pages: z
    .union([z.number().int().positive(), z.array(z.number().int().positive()), z.object({ from: z.number(), to: z.number() })])
    .optional(),
});

function listUrls(params: z.infer<typeof paramsSchema>): string[] {
  if (params.urls && params.urls.length > 0) return params.urls;
  const pages = resolvePages(params.pages);
  const query = params.search ?? params.category;
  if (!query) return [];
  const pageSize = 50;
  return pages.map((page) => {
    const from = (page - 1) * pageSize;
    const to = page * pageSize - 1;
    const q = encodeURIComponent(query);
    return `${BASE}/api/catalog_system/pub/products/search/${q}?_from=${from}&_to=${to}`;
  });
}

export const oechsleProductsScraper = defineScraper({
  id: "oechsle-pe-products",
  store: "oechsle-pe",
  version: 1,
  match: [BASE + "/"],
  paramsSchema,
  defaults: { maxRequests: 500, maxDurationMs: 1_800_000, downloadImages: true },
  selfCheck(): ProductInput[] {
    const dir = join(import.meta.dir, "__fixtures__");
    const json = JSON.parse(readFileSync(join(dir, "search-televisores.json"), "utf8"));
    return normalizeOechsleSearchResults(json).products;
  },
  async scrape(ctx): Promise<{ pagesProcessed: number; productsSeen: number }> {
    const params = ctx.params;
    const urls = listUrls(params);
    let pagesProcessed = 0;
    let productsSeen = 0;
    for (const url of urls) {
      const res = await ctx.http.fetch(url, { class: "document" });
      pagesProcessed++;
      if (res.notModified) continue;
      const json = JSON.parse(res.body);
      const { products, ok } = normalizeOechsleSearchResults(json);
      if (!ok) {
        ctx.logger.warn("oechsle search assertion failed", { url });
        continue;
      }
      for (const product of products) {
        productsSeen++;
        ctx.save.productSnapshot({
          ...product,
          sourceUrl: url,
          sourceHash: res.bodyHash ?? undefined,
        });
      }
    }
    return { pagesProcessed, productsSeen };
  },
});
