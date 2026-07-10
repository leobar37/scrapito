/**
 * fixture-products — a registered scraper used only by the integration test.
 * It exercises the full pipeline (fetch -> normalize -> save -> image queue)
 * against a single allowlisted URL whose response is supplied by the test's
 * injected HTTP fetch. It reuses the real Falabella normalizer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProductInput } from "../domain/schemas.ts";
import { defineScraper } from "./define-scraper.ts";
import { normalizeFalabellaList } from "./falabella-pe/normalize.ts";

const BASE = "https://www.falabella.com.pe";
export const FIXTURE_LIST_URL = `${BASE}/fixture/list`;

export const fixtureProductsScraper = defineScraper({
  id: "fixture-products",
  store: "falabella-pe",
  version: 1,
  match: [BASE + "/"],
  paramsSchema: z.object({}).passthrough(),
  selfCheck(): ProductInput[] {
    const dir = join(import.meta.dir, "falabella-pe", "__fixtures__");
    const listHtml = readFileSync(join(dir, "list.html"), "utf8");
    return normalizeFalabellaList(listHtml).products;
  },
  async scrape(ctx): Promise<{ pagesProcessed: number; productsSeen: number }> {
    const res = await ctx.http.fetch(FIXTURE_LIST_URL, { class: "document" });
    if (res.notModified) return { pagesProcessed: 1, productsSeen: 0 };
    const { products, ok } = normalizeFalabellaList(res.body);
    if (!ok) {
      ctx.logger.warn("fixture list assertion failed", { url: FIXTURE_LIST_URL });
      return { pagesProcessed: 1, productsSeen: 0 };
    }
    let productsSeen = 0;
    for (const product of products) {
      productsSeen++;
      ctx.save.productSnapshot({
        ...product,
        sourceUrl: FIXTURE_LIST_URL,
        sourceHash: res.bodyHash ?? undefined,
      });
    }
    return { pagesProcessed: 1, productsSeen };
  },
});
