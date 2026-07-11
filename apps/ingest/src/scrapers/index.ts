export { defineScraper, scraperMatches } from "./define-scraper.ts";
export type { Scraper, ScraperSpec, ScraperDefaults } from "./define-scraper.ts";
export type {
  ScrapeContext,
  ScrapeHttp,
  ScrapeSave,
  SaveOutcome,
  ScrapeRun,
  ScrapeFn,
  ScrapeResultSummary,
  BrowserRecipe,
} from "./context.ts";
export { getScraper, listScrapers, hasScraper } from "./registry.ts";
export { resolvePages } from "./pages.ts";
export {
  normalizeRipleyList,
  normalizeRipleyDetail,
  normalizeRipleyDetailNextData,
} from "./ripley-pe/normalize.ts";
export {
  normalizeFalabellaList,
  normalizeFalabellaDetail,
} from "./falabella-pe/normalize.ts";
export { FIXTURE_LIST_URL } from "./fixture-products.ts";
