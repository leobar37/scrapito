/**
 * Ripley Peru products scraper. Lists via SSR __NEXT_DATA__, optionally follows
 * product-detail pages for JSON-LD-backed fields. Reviewed & statically
 * registered — never remotely supplied.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProductInput } from "@scrapito/contracts";
import { defineScraper } from "../define-scraper.ts";
import { resolvePages } from "../pages.ts";
import { normalizeRipleyDetail, normalizeRipleyDetailNextData, normalizeRipleyList } from "./normalize.ts";

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
  /** Follow each product's detail page for full gallery, variants, and description. */
  detail: z.boolean().optional(),
  /** Scrape the storefront homepage once and pass its SSR payload through the
   *  list normalizer. Useful for daily homepage snapshots. */
  home: z.boolean().optional(),
});
function listUrls(params: z.infer<typeof paramsSchema>): string[] {
  if (params.urls && params.urls.length > 0) return params.urls;
  if (params.home) return [`${BASE}/`];
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
        const listSnap: ProductInput = { ...product, sourceUrl: url, sourceHash: res.bodyHash ?? undefined };
        if (params.detail && !ctx.budget.isExhausted()) {
          const enriched = await followDetail(ctx, listSnap);
          if (enriched) {
            ctx.save.productSnapshot(enriched);
            pagesProcessed++;
            continue;
          }
        }
        ctx.save.productSnapshot(listSnap);
      }
    }
    return { pagesProcessed, productsSeen };
  },
});

/** Fetch a product's detail page and merge its richer fields (full gallery,
 * variants, description, specs) onto the list snapshot. Returns null on any
 * failure so the caller can fall back to the list snapshot. */
async function followDetail(
  ctx: Parameters<typeof ripleyProductsScraper.scrape>[0],
  base: ProductInput,
): Promise<ProductInput | null> {
  try {
    const res = await ctx.http.fetch(base.canonicalUrl, { class: "document" });
    if (res.notModified) return null;
    const detail =
      normalizeRipleyDetailNextData(res.body, base.canonicalUrl) ??
      normalizeRipleyDetail(res.body, base.canonicalUrl);
    if (!detail) return null;
    return {
      ...base,
      description: detail.description ?? base.description ?? null,
      attributes: Object.keys(detail.attributes ?? {}).length > 0 ? detail.attributes : base.attributes,
      images: detail.images.length > 0 ? detail.images : base.images,
      variants: detail.variantsObserved ? detail.variants : base.variants,
      variantsObserved: detail.variantsObserved || base.variantsObserved,
      sourceUrl: base.canonicalUrl,
    };
  } catch (err) {
    ctx.logger.warn("ripley detail fetch failed", { url: base.canonicalUrl, error: String(err) });
    return null;
  }
}
