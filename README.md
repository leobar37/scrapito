# scrapito

A Peru-only e-commerce offer catalog (Ripley PE, Falabella PE) split into a
Bun workspace monorepo:

- **`apps/api`** — an always-on, physically read-only Hono HTTP API. It opens
  the shared SQLite catalog through `@scrapito/catalog/read` only and can
  never enqueue, cancel, or execute scraping work. There is no job queue.
- **`apps/ingest`** — the `scrap-ingest` operator/agent CLI. Invoked
  occasionally (by a human or an external agent) to run one synchronous,
  single-writer ingestion pass against the shared catalog, then exits.
- **`apps/web`** — a TanStack Start web app that queries the API over HTTP
  (SSR + client), for humans browsing offers.
- **`packages/contracts`** — runtime-neutral Zod schemas/types shared by all
  three: product/variant/offer models, the offer search input codec, DTOs,
  and the API error envelope.
- **`packages/catalog`** — the only owner of the SQLite file. `./read` is a
  strictly readonly connection (no migrations, no writes, ever); `./write`
  owns migrations, the single-writer lease, and every mutating store.

The API is **not** a job runner or a queue owner. It only ever answers reads.
All writes happen through one synchronous CLI invocation at a time, guarded
by a single-writer lease in SQLite.

## Topology

```
                 ┌──────────────┐        HTTP (GET only)      ┌──────────────┐
   Human/Agent → │  apps/web    │ ───────────────────────────▶│   apps/api   │
                 │ (TanStack    │                              │ (Hono, read- │
                 │  Start SSR)  │                              │  only)       │
                 └──────────────┘                              └──────┬───────┘
                                                                        │ @scrapito/catalog/read
                                                                        ▼
   External Agent/Operator                                    ┌──────────────┐
        │ `scrap-ingest run <id> --json`                       │  scrap.sqlite │
        ▼                                                       │  (WAL)       │
 ┌──────────────┐   @scrapito/catalog/write + writer_leases    └──────────────┘
 │ apps/ingest  │ ─────────────────────────────────────────────────────▲
 │ (CLI, one    │                                                       │
 │  writer at   │───────────────────────────────────────────────────────┘
 │  a time)     │
 └──────────────┘
```

## Development

```bash
bun install

# 1. Apply migrations (creates data/scrap.sqlite on first run)
bun run db:migrate

# 2. Start the read-only API (127.0.0.1:3000 by default)
bun run dev:api

# 3. Start the web app (needs both API bases; see apps/web env below)
API_BASE_URL=http://127.0.0.1:3000 \
VITE_PUBLIC_API_BASE_URL=http://127.0.0.1:3000 \
bun run dev:web

# 4. Periodically (human or external agent), run an ingestion pass:
SCRAP_USER_AGENT="YourBot/1.0 (+https://you.example/bot-info)" \
bun run ingest -- run fixture-products --json
```

`scrap-ingest run` is the **only** way data changes. It acquires a single-
writer lease (`writer_leases` table, 60s TTL, refreshed every ~10s); a second
concurrent `run`/`discover` invocation fails immediately with `WRITER_LOCKED`
and exits 1. On startup it also recovers any orphaned `running` row left by a
crashed process (`failStaleRunning`, reason `ingest_restarted`).

Inspect freshness/history without touching the writer lease at all:

```bash
curl http://127.0.0.1:3000/freshness
curl http://127.0.0.1:3000/updates
bun run ingest -- offers query --query "laptop" --sort discount_desc --json
```

...or just browse `http://127.0.0.1:3001/offers?q=laptop` in the web app.

## Verification

```bash
bun run typecheck                 # every workspace package
bun run test                      # unit tests (all packages) + tests/integration
bun run test:integration          # cross-app pipeline + security/boundary tests
bun run test:live                 # opt-in, AGENT_BROWSER_LIVE=1 + SCRAP_USER_AGENT, never in CI
bun run build:web                 # apps/web client + SSR bundle
```

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `SCRAP_DB_PATH` | catalog (read+write) | Shared SQLite file path. |
| `SCRAP_STORAGE_DIR` | ingest, api | Content-addressed image storage root. |
| `SCRAP_USER_AGENT` | ingest | Honest UA; required for `run`/`discover`. |
| `SCRAP_HOST` / `SCRAP_PORT` | api | API bind address (default `127.0.0.1:3000`). |
| `SCRAP_PUBLIC_READS` | api | Must be exactly `true` to bind a non-loopback host. |
| `WEB_ORIGIN` | api | Comma-separated exact browser origins allowed by CORS (GET/HEAD/OPTIONS only). |
| `API_BASE_URL` | web (server) | Server-only Hono API base for SSR loaders/server functions. |
| `VITE_PUBLIC_API_BASE_URL` | web (browser) | Browser-visible Hono API base. |
| `AGENT_BROWSER_LIVE`, `AGENT_BROWSER_BIN` | ingest | Real-browser fallback + `test:live` gate. |

## Package boundaries (enforced by `tests/integration/security.test.ts`)

- `apps/api` imports only `@scrapito/contracts` and `@scrapito/catalog/read`
  — never `@scrapito/catalog/write`, `@scrapito/ingest`, `agent-browser`,
  discovery, the scraper registry, or a scrape runner.
- `apps/ingest` imports `@scrapito/contracts` and both `@scrapito/catalog/read`
  and `@scrapito/catalog/write` — never depends on `apps/api` or `apps/web`.
- `apps/web` imports only `@scrapito/contracts` — never `@scrapito/catalog` or
  `@scrapito/ingest`; every loader talks to `apps/api` over HTTP.
- `apps/ingest/src/scrapers/registry.ts` never imports
  `apps/ingest/src/discovery/**`, and vice versa — discovery is a local-only,
  never-server-reachable reconnaissance tool (`scrap-ingest discover`).

## Offers

Every priced product is classified at query time (see
`deriveOffer` in `@scrapito/contracts`, mirrored by the `current_offers` SQL
view): `verified_discount` requires a positive `regularCents` strictly above
the effective price; a promotional/card price without a trustworthy regular
price is `promotional_price`; a row with neither an offer nor a card price is
not an offer at all. Card-only pricing is always disclosed via
`priceAccess: "card"` and separately filterable.
