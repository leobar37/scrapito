/**
 * Ripley discovery: captures listing/search scenarios (SSR shape + HAR +
 * per-scenario request snapshots) so an operator can author/update the
 * reviewed runtime scraper. It NEVER promotes or registers anything
 * automatically. Two category pages and one search are captured so the
 * offline analyzer can diff pagination parameters across scenarios.
 */
import { defineDiscovery } from "../define-discovery.ts";
import { runDiscoveryCapture } from "../capture.ts";

const BASE = "https://simple.ripley.com.pe";

export const ripleyDiscovery = defineDiscovery({
  scraperId: "ripley-pe-products",
  store: "ripley-pe",
  run: (ctx) =>
    runDiscoveryCapture(ctx, {
      scraperId: "ripley-pe-products",
      store: "ripley-pe",
      scenarios: [
        { name: "category", url: `${BASE}/tecnologia` },
        { name: "category-page-2", url: `${BASE}/tecnologia?page=2` },
        { name: "search", url: `${BASE}/search/laptop` },
      ],
    }).then(() => {}),
});
