/**
 * Promart discovery: captures category scenarios with the browser so the
 * offline analyzer can rediscover the VTEX catalog XHR endpoints the
 * production scraper already uses. This is the validation case for the
 * HAR → endpoint-candidate pipeline: analysis output can be diffed against
 * the known-good `/api/catalog_system/pub/products/search` adapter. It NEVER
 * promotes or registers anything automatically.
 */
import { defineDiscovery } from "../define-discovery.ts";
import { runDiscoveryCapture } from "../capture.ts";

const BASE = "https://www.promart.pe";

export const promartDiscovery = defineDiscovery({
  scraperId: "promart-pe-products",
  store: "promart-pe",
  run: (ctx) =>
    runDiscoveryCapture(ctx, {
      scraperId: "promart-pe-products",
      store: "promart-pe",
      scenarios: [
        { name: "category", url: `${BASE}/refrigeracion` },
        { name: "category-page-2", url: `${BASE}/refrigeracion?page=2` },
        { name: "search", url: `${BASE}/laptop?_q=laptop&map=ft` },
      ],
    }).then(() => {}),
});
