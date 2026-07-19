# Repository Guidelines

## Project Overview

`scrapito` is a **Peru-only e-commerce offer catalog** (Ripley PE, Falabella
PE, Promart PE, Oechsle PE) built on **Bun + TypeScript**, split into a Bun
workspace monorepo:

- `apps/api` — always-on, physically read-only Hono HTTP API.
- `apps/ingest` — the `scrap-ingest` CLI: synchronous, single-writer scraping
  runs. No job queue, no server, no worker loop.
- `apps/web` — TanStack Start web app (SSR + client) over the API.
- `packages/contracts` — shared Zod schemas/types (product/variant/offer
  models, DTOs, offer search codec, `ApiError`). Runtime-neutral: no
  `bun:sqlite`, filesystem, browser, Hono, or scraper imports.
- `packages/catalog` — the only owner of the shared SQLite file.
  `@scrapito/catalog/read` is strictly readonly (no migrations, no writes,
  ever); `@scrapito/catalog/write` owns migrations, the single-writer lease,
  and every mutating store.

Every network call inside `apps/ingest` flows through one policy chokepoint
(allowlist, robots.txt, circuit breaker, SSRF guard); no scraper can execute
arbitrary remote code or reach raw SQLite/subprocess/`eval` outside that.

## Architecture & Data Flow

1. **Ingestion** — `apps/ingest/src/cli/index.ts` (`scrap-ingest run <id>
   --json`) is the only entry point that writes. It acquires the
   `writer_leases` row `catalog-ingest` (60s TTL, ~10s heartbeat) before
   touching the catalog; a concurrent invocation fails fast with
   `WRITER_LOCKED`. `app/services.ts` (`openIngestWriter` /
   `buildIngestRunner`) wires `CrawlPolicy` → `ImageWorker` +
   `BrowserManager` → `ScrapeRunner` on top of an already-open
   `CatalogWriter`.
2. **Scraping** — `ScrapeRunner.run()` validates params, builds a
   `ScrapeContext`, and calls a statically registered `Scraper.scrape(ctx)`.
   `ctx.http.fetch()` is routed through `CrawlPolicy`; `ctx.save.productSnapshot()`
   validates via `ProductInputSchema`, splits raw variants through
   `validateVariants()` (malformed/duplicate entries never reject the parent),
   and commits product + variants + canonical image sources + run-owned image
   targets in one transaction (`CatalogStore.productSnapshot`).
3. **Images** — `ImageWorker.processRun(runId, …)` drains ONLY image sources
   owned (via `image_source_targets`) by that run, downloads each distinct
   URL at most once, and links the result to every product/variant target.
4. **Offers** — `current_offers` (SQL view, `packages/catalog/src/migrations/0004_offer_search.sql`)
   mirrors `deriveOffer()` in `@scrapito/contracts`: `effectiveCents` is the
   lower of `offerCents ?? regularCents` and `cardCents` (ties prefer
   public); `verified_discount` requires a positive `regularCents` strictly
   above the effective price.
5. **API** — `apps/api/src/app.ts` opens `@scrapito/catalog/read` only and
   exposes GET routes: `/products`, `/products/:id` (incl. active variants),
   `/offers`, `/offers/:id/history`, `/updates`, `/freshness`, `/images/:sha`.
   No mutation routes exist.
6. **Discovery (isolated)** — `apps/ingest/src/discovery/` is a deliberately
   separate module graph, used only by `scrap-ingest discover` for
   exploratory browser reconnaissance. `scrapers/registry.ts` MUST NOT import
   from `discovery/**`, and vice versa (enforced by
   `tests/integration/security.test.ts`).

## Key Directories

| Path | Purpose |
|---|---|
| `packages/contracts/src/` | `ids.ts`, `errors.ts`, `schemas.ts` (product/variant input), `variants.ts` (validateVariants), `dtos.ts`, `offers.ts` (deriveOffer, search input/codec, response schemas), `ingestion.ts`, `cursor.ts` |
| `packages/catalog/src/migrations/` | `0001_init.sql` (never edit), `0002_remove_job_queue.sql`, `0003_variants_and_image_targets.sql`, `0004_offer_search.sql` |
| `packages/catalog/src/read/` | `db.ts` (readonly open), `queries.ts` (`CatalogQueries`, incl. `searchOffers`), `offer-cursor.ts` (SHA-256 keyset cursor) |
| `packages/catalog/src/write/` | `db.ts` (WAL open + migration runner), `catalog-store.ts`, `run-store.ts`, `writer-lease.ts`, `migrate.ts` |
| `apps/ingest/src/policy/` | Network chokepoint: `crawl-policy.ts`, `circuit-breaker.ts`, `allowlist.ts`, `budget.ts`, `robots.ts`, `http-cache.ts` |
| `apps/ingest/src/scrapers/` | `define-scraper.ts`, `registry.ts`, `context.ts`, `ripley-pe/`, `falabella-pe/` |
| `apps/ingest/src/cli/index.ts` | `scrap-ingest`: `db`, `browser`, `stores`, `scrapers`, `discover`, `run`, `offers query` |
| `apps/ingest/src/discovery/` | Local-only reconnaissance, never server-reachable |
| `apps/api/src/` | `app.ts` (routes), `serve.ts` (bind gate), `cors.ts` (strict exact-origin CORS) |
| `apps/web/src/routes/` | `__root.tsx`, `index.tsx` (→`/offers`), `offers.tsx`, `products.$productId.tsx`, `updates.tsx` |
| `tests/integration/` | Cross-app pipeline + security/module-graph boundary tests |
| `tests/live/` | Opt-in smoke tests against real sites (never CI) |

## Development Commands

```bash
bun install
bun run typecheck              # every workspace package
bun run test                   # unit tests (all packages) + tests/integration
bun run test:integration       # bun test tests/integration
bun run test:live              # bun test tests/live (needs AGENT_BROWSER_LIVE=1 + SCRAP_USER_AGENT)
bun run db:migrate             # packages/catalog write-side migration runner
bun run dev:api / dev:web      # apps/api / apps/web dev servers
bun run build:web              # apps/web client + SSR bundle
bun run ingest -- run <id> --json   # scrap-ingest CLI
```

## Quick Reference — Available Stores & Capabilities

External agents can discover what stores and scrapers are available without
reading code, via these CLI commands:

```bash
# List every registered scraper (id, store, version, defaults)
bun run ingest -- scrapers list

# Full capability matrix: every site × strategy × capability cell
# (category:acquire, search:acquire, etc.), with supported status and evidence
bun run ingest -- target matrix

# List configured store IDs (requires DB)
bun run ingest -- stores list
```

**Currently registered stores:** `ripley-pe`, `falabella-pe`, `promart-pe`, `oechsle-pe`

All VTEX-based stores (promart-pe, oechsle-pe) use the public VTEX Search API
(no browser needed). Ripley and Falabella use SSR HTML parsing with `__NEXT_DATA__`.
Every scraper has a `selfCheck()` that validates offline via checked-in fixtures.

### Invocation quick-start

```bash
# Acquire products by category (Oechsle example)
bun run ingest -- target run invocation.json

# Or pipe from stdin
echo '{"site":"oechsle-pe","intent":"acquire","target":{"kind":"category","externalId":"tecnologia/televisores"},"constraints":{"pages":{"from":1,"to":2}}}' | bun run ingest -- target run -
```

## Code Conventions & Common Patterns

- **Constructor-injection DI, no framework**: classes take deps via
  constructor params with `?? nullLogger` / `?? systemClock` defaults.
- **Typed error hierarchy**: `ScrapError` base (`@scrapito/contracts`) with a
  fixed `code` per subclass (`PolicyError`, `CircuitOpenError`,
  `BudgetExhaustedError`, `ChallengeDetectedError`, `WriterLockedError`, …).
- **Zod at every boundary**: `@scrapito/contracts` schemas validate product
  snapshots, variant inputs, offer search params, and every API response.
- **"Lower only" budget clamping**: CLI-supplied `maxRequests`/`maxDurationMs`
  are always `Math.min`'d against the scraper's own declared ceiling.
- **Package boundaries are load-bearing**: `apps/api` never imports
  `@scrapito/catalog/write` or anything under `apps/ingest`; `apps/web` never
  imports `@scrapito/catalog` or `@scrapito/ingest`. See
  `tests/integration/security.test.ts` for the enforced graph walker.
- **Single writer**: only `scrap-ingest run`/`discover` open
  `@scrapito/catalog/write`, guarded by the `writer_leases` row.
- **Naming**: kebab-case filenames, PascalCase classes, camelCase
  functions/vars, `*Schema` suffix for Zod schemas, `create*`/`open*`/
  `build*`/`define*` factory-function prefixes.

## Runtime/Tooling Preferences

- **Runtime**: Bun (not Node), Bun workspaces (`apps/*`, `packages/*`).
- **TypeScript**: `tsconfig.base.json` — strict, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
  no path aliases anywhere — cross-package imports resolve via normal
  `node_modules`/workspace symlinks and each package's `package.json#exports`.
- **Module system**: ESM (`"type": "module"`).
- Excluded from tsconfig/build: `node_modules`, `data/`, `storage/`.

## Testing & QA

- **Unit tests**: colocated `*.test.ts` per package, run via each package's
  `bun test src`.
- **Integration tests** (`tests/integration/`): `pipeline.test.ts` (real
  temp-file SQLite, separate writer/reader connections, no real network) and
  `security.test.ts` (SSRF/policy/CORS/404 boundaries plus the
  workspace-aware module graph walker).
- **Live tests** (`tests/live/`): opt-in, gated by `AGENT_BROWSER_LIVE=1` +
  `SCRAP_USER_AGENT`, never run in CI.
- **No mocking library**: dependency-injected fakes (`FakeClock`, fake
  `HttpFetch`/`ImageFetch`).
