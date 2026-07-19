/**
 * Falabella discovery: captures category/search scenarios (SSR shape + HAR +
 * per-scenario request snapshots) for offline endpoint analysis. It NEVER
 * promotes or registers anything automatically.
 */
import { defineDiscovery } from "../define-discovery.ts";
import { runDiscoveryCapture } from "../capture.ts";

const BASE = "https://www.falabella.com.pe";

export const falabellaDiscovery = defineDiscovery({
  scraperId: "falabella-pe-products",
  store: "falabella-pe",
  run: (ctx) =>
    runDiscoveryCapture(ctx, {
      scraperId: "falabella-pe-products",
      store: "falabella-pe",
      scenarios: [
        { name: "category", url: `${BASE}/falabella-pe/category/cat7230028/Tecnologia` },
        { name: "category-page-2", url: `${BASE}/falabella-pe/category/cat7230028/Tecnologia?page=2` },
        { name: "search", url: `${BASE}/falabella-pe/search?Ntt=laptop` },
      ],
    }).then(() => {}),
});
