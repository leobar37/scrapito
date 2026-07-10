/**
 * Ripley Peru products scraper. Lists via SSR __NEXT_DATA__, optionally follows
 * product-detail pages for JSON-LD-backed fields. Reviewed & statically
 * registered — never remotely supplied.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProductInput } from "../../domain/schemas.ts";
import { defineScraper } from "../define-scraper.ts";
import { resolvePages } from "../pages.ts";
import { normalizeRipleyDetail, normalizeRipleyList } from "./normalize.ts";

const BASE = "https://simple.ripley.com.pe";

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
    return pages.map((page) => `${BASE}/search/${term}?page=${page}`);
  }
  if (params.category) {
    return pages.map((page) => `${BASE}/${params.category}?page=${page}`);
  }
  return [];
}

export const ripleyProductsScraper = defineScraper({
  id: "ripley-pe-products",
  store: "ripley-pe",
  version: 1,
  match: [BASE + "/"],
  paramsSchema,
  selfCheck(): ProductInput[] {
    const dir = join(import.meta.dir, "__fixtures__");
    const listHtml = readFileSync(join(dir, "list.html"), "utf8");
    const detailHtml = readFileSync(join(dir, "detail.html"), "utf8");
    const { products } = normalizeRipleyList(listHtml);
    const detail = normalizeRipleyDetail(
      detailHtml,
      `${BASE}/laptop-hp-15-2000389084910p`,
    );
    return detail ? [...products, detail] : products;
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
      const { products, ok } = normalizeRipleyList(res.body);
      if (!ok) {
        ctx.logger.warn("ripley list assertion failed", { url });
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
