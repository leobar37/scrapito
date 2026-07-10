/**
 * Opt-in live smoke test. Runs ONLY when `AGENT_BROWSER_LIVE=1` and an honest
 * `SCRAP_USER_AGENT` are set. Limited to one list page and one product detail
 * per store, HTTP/SSR first, no browser on the happy path. NEVER run in CI.
 */
import { test, expect } from "bun:test";
import {
  CrawlPolicy,
  defaultHttpFetch,
  defaultImageFetch,
} from "../../src/policy/crawl-policy.ts";
import { normalizeRipleyList } from "../../src/scrapers/ripley-pe/normalize.ts";
import { normalizeFalabellaList } from "../../src/scrapers/falabella-pe/normalize.ts";
import { ProductInputSchema } from "../../src/domain/schemas.ts";

const LIVE = process.env.AGENT_BROWSER_LIVE === "1" && !!process.env.SCRAP_USER_AGENT;
const maybe = LIVE ? test : test.skip;

function makePolicy(): CrawlPolicy {
  return new CrawlPolicy({
    userAgent: process.env.SCRAP_USER_AGENT ?? "",
    httpFetch: defaultHttpFetch(),
    imageFetch: defaultImageFetch(),
  });
}

maybe(
  "Ripley: one live listing page yields validated PEN products (SSR-first)",
  async () => {
    const policy = makePolicy();
    const url = "https://simple.ripley.com.pe/tecnologia";
    const res = await policy.fetch(url, { class: "document" });
    const { products, ok } = normalizeRipleyList(res.body);
    expect(ok).toBe(true);
    expect(products.length).toBeGreaterThan(0);
    for (const p of products.slice(0, 5)) {
      expect(ProductInputSchema.safeParse(p).success).toBe(true);
    }
  },
  60_000,
);

maybe(
  "Falabella: one live listing page yields validated PEN products (SSR-first)",
  async () => {
    const policy = makePolicy();
    const url = "https://www.falabella.com.pe/falabella-pe/category/cat70057/Celulares-y-Telefonos";
    const res = await policy.fetch(url, { class: "document" });
    const { products, ok } = normalizeFalabellaList(res.body);
    expect(ok).toBe(true);
    for (const p of products.slice(0, 5)) {
      expect(ProductInputSchema.safeParse(p).success).toBe(true);
    }
  },
  60_000,
);
