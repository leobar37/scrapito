/**
 * Falabella Peru products scraper. Lists via SSR __NEXT_DATA__ results; reviewed
 * & statically registered.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProductInput } from "@scrapito/contracts";
import { defineScraper } from "../define-scraper.ts";
import { resolvePages } from "../pages.ts";
import { normalizeFalabellaList } from "./normalize.ts";

const BASE = "https://www.falabella.com.pe";

const paramsSchema = z.object({
  category: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  urls: z.array(z.string().url()).optional(),
  pages: z
    .union([
      z.number().int().positive(),
      z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
      z.array(z.number().int().positive()),
    ])
    .optional(),
});

function listUrls(params: z.infer<typeof paramsSchema>): string[] {
  if (params.urls && params.urls.length > 0) return params.urls;
  const pages = resolvePages(params.pages);
  if (params.search) {
    const term = encodeURIComponent(params.search);
    return pages.map((page) => `${BASE}/falabella-pe/search?Ntt=${term}&page=${page}`);
  }
  if (params.category) {
    return pages.map((page) => `${BASE}/falabella-pe/category/${params.category}?page=${page}`);
  }
  return [];
}

export const falabellaProductsScraper = defineScraper({
  id: "falabella-pe-products",
  store: "falabella-pe",
  version: 1,
  match: [BASE + "/"],
  paramsSchema,
  selfCheck(): ProductInput[] {
    const dir = join(import.meta.dir, "__fixtures__");
    const listHtml = readFileSync(join(dir, "list.html"), "utf8");
    return normalizeFalabellaList(listHtml).products;
  },
  async scrape(ctx): Promise<{ pagesProcessed: number; productsSeen: number }> {
    const urls = listUrls(ctx.params);
    let pagesProcessed = 0;
    let productsSeen = 0;
    for (const url of urls) {
      const res = await ctx.http.fetch(url, { class: "document" });
      pagesProcessed++;
      if (res.notModified) continue;
      const { products, ok } = normalizeFalabellaList(res.body);
      if (!ok) {
        ctx.logger.warn("falabella list assertion failed", { url });
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
