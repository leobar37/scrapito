# scrapito

A Peru-only e-commerce **offer catalog** (Ripley PE, Falabella PE). It scrapes
product prices, stores them in a shared SQLite catalog, and serves them through
a read-only HTTP API, a web UI, and a CLI. All prices are integer **cents** in
**PEN**.

It is a Bun workspace monorepo:

| Workspace | What it is |
|---|---|
| **`apps/api`** | Always-on, physically read-only Hono HTTP API. Opens `@scrapito/catalog/read` only — no queue, no writes, ever. |
| **`apps/ingest`** | The `scrap-ingest` CLI. The **only** writer: one synchronous, single-writer scraping pass per invocation, then it exits. |
| **`apps/web`** | TanStack Start web app (SSR + client) that talks to the API over HTTP. |
| **`packages/contracts`** | Runtime-neutral Zod schemas/types shared by all three (product/variant/offer models, offer-search codec, DTOs, error envelope). |
| **`packages/catalog`** | Sole owner of the SQLite file. `./read` = strictly readonly; `./write` = migrations + single-writer lease + mutating stores. |

> The golden rule: **exactly one writer at a time** (the CLI, guarded by a
> SQLite lease), and **everything else only reads**.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (the runtime, package manager, and test runner —
  Node is not used).
- For real scraping only: a Chromium-class browser via `agent-browser`
  (`bun run browser:install`) and an honest `SCRAP_USER_AGENT`.

---

## Quickstart

```bash
# 1. Install workspace dependencies
bun install

# 2. Create + migrate the SQLite catalog (writes ./data/scrap.sqlite)
bun run db:migrate

# 3. Start the read-only API on http://127.0.0.1:3000
bun run dev:api
```

Verify it is up (a fresh catalog is **empty** until you ingest data):

```bash
curl http://127.0.0.1:3000/health        # {"data":{"status":"ok"}}
curl http://127.0.0.1:3000/freshness      # per-store data age (empty at first)
curl 'http://127.0.0.1:3000/offers'       # {"data":[],"nextCursor":null,"facets":{...}}
```

Optionally start the web UI (needs both API base URLs; it runs on **:3001**):

```bash
API_BASE_URL=http://127.0.0.1:3000 \
VITE_PUBLIC_API_BASE_URL=http://127.0.0.1:3000 \
bun run dev:web
# → browse http://127.0.0.1:3001/offers
```

To get actual offers into the catalog, run an ingestion pass (next section).

---

## Updating the catalog (ingestion)

`scrap-ingest run <scraperId>` is the **only** way data changes. It acquires a
single-writer lease (`writer_leases`, 60s TTL, refreshed ~10s); a second
concurrent `run`/`discover` fails immediately with `WRITER_LOCKED` (exit 1). On
startup it also recovers orphaned `running` rows from a crashed process.

Real scraping needs a browser and an honest user agent:

```bash
bun run browser:install          # one-time: install agent-browser
bun run browser:doctor           # verify the browser works
export SCRAP_USER_AGENT="YourBot/1.0 (+https://you.example/bot-info)"

# Ripley PE, "tecnologia" category, pages 1–3, one JSON result line on stdout:
bun run ingest -- run ripley-pe --category tecnologia --pages 1-3 --json

# Falabella PE, keyword search, capped budget, no image downloads:
bun run ingest -- run falabella-pe --search juguetes --max-requests 40 --no-images --json
```

`run` options: `--category <v>`, `--search <term>`, `--pages <n|a-b>`,
`--max-requests <n>`, `--max-duration <ms>`, `--no-images`, `--json`. Supplied
budgets are always clamped **down** against the scraper's own ceiling.

Result (`--json` emits exactly one line on stdout; logs go to stderr):

```json
{"runId":"...","scraperId":"ripley-pe","storeId":"ripley-pe","status":"completed",
 "startedAt":"...","finishedAt":"...","productsSaved":42,"productsRejected":0,
 "imagesDownloaded":40,"requestsMade":12,"error":null}
```

`status` is `completed | partial | failed` (exit 1 on `failed`).

> `fixture-products` is a registered scraper used by the integration test to
> exercise the pipeline against an injected response; it is **not** a way to
> seed real offers.


### Evidence-backed handoff for external agents

Scrapito stops at scraper/data ownership. Selection rules, the consuming LLM,
Discord, rendering, delivery, idempotency and retries belong to the **external
agent**. The integration is deliberately two-step:

```bash
# 1. Run one caller-defined category target. Stdout is one InvocationResult.
bun run ingest -- target run invocation.json
# → {"invocationId":"external-42",...,"coverage":{"coverageId":17,...}}

# 2. Read only the exact products sighted in coverage 17.
curl 'http://127.0.0.1:3000/coverages/17/offers?limit=50'
bun run ingest -- offers handoff 17 --limit 50 --api-base-url http://127.0.0.1:3000 --json
```

`CoverageOfferHandoff` fixes every offer to the price observation and immutable
name/brand/canonical URL/seller snapshot captured by that coverage's sighting;
a later run changing price or product metadata cannot leak into an older
handoff. Its opaque cursor is coverage-bound. Partial coverage is returned as
partial with boundary/stop reason intact.

Migration `0009_product_sighting_identity_snapshot.sql` is additive. Run
`bun run db:migrate` before producing new handoffs. Existing sightings are not
backfilled from mutable `products`: a coverage containing a legacy sighting
fails closed as `COVERAGE_HANDOFF_UNAVAILABLE`. This initially works where a
coverage exists (category targets); search/legacy results with `coverage: null`
also have no handoff.

---

## Querying offers

Four equivalent ways — all share the same validation/semantics via
`@scrapito/contracts`.

**1. Web UI** — browse `http://127.0.0.1:3001/offers?q=laptop`.

**2. HTTP API** (no auth; read-only):

```bash
curl 'http://127.0.0.1:3000/offers?quality=verified_discount&sort=discount_desc&limit=10'
curl 'http://127.0.0.1:3000/offers?store=ripley-pe&priceAccess=card&minDiscountBps=2000'
curl 'http://127.0.0.1:3000/offers/123/history'     # price/offer history for a product
```

**3. CLI** (`offers query` validates locally, then calls the API — start the API first):

```bash
bun run ingest -- offers query --query "laptop" --sort discount_desc --json
bun run ingest -- offers query --store ripley-pe --brand Samsung --price-access card --json
```

**4. Script** (read the catalog directly, no server needed — recommended for automation):

```ts
// scripts/my-report.ts  →  bun run scripts/my-report.ts
import { openCatalogReader } from "@scrapito/catalog/read";
import { decodeOfferSearchParams } from "@scrapito/contracts";

const reader = openCatalogReader(process.env.SCRAP_DB_PATH ?? "data/scrap.sqlite");
try {
  const input = decodeOfferSearchParams(
    new URLSearchParams({ quality: "verified_discount", sort: "discount_desc", limit: "10" }),
  );
  for (const o of reader.queries.searchOffers(input).data) {
    console.log(`${o.storeId}  S/ ${(o.effectiveCents / 100).toFixed(2)}  ${o.name}`);
  }
} finally {
  reader.close();
}
```

### Offer search filters (`GET /offers` query params)

| Param | Values | Notes |
|---|---|---|
| `q` | text (≤200 code points) | escaped FTS5 phrase |
| `store` | `ripley-pe` \| `falabella-pe` | repeatable |
| `categoryId` | positive int | repeatable |
| `brand` | text | repeatable |
| `quality` | `verified_discount` \| `promotional_price` | repeatable |
| `priceAccess` | `public` \| `card` | repeatable |
| `inStock` | `true` \| `false` | default `true` |
| `minEffectiveCents` / `maxEffectiveCents` | int cents | min ≤ max |
| `minDiscountBps` | 0–10000 | `2000` = 20% |
| `sort` | `relevance` \| `discount_desc` \| `price_asc` \| `price_desc` \| `updated_desc` | `relevance` requires `q`; default `discount_desc` (or `relevance` when `q` is present) |
| `cursor` | opaque | keyset pagination |
| `limit` | 1–100 | default 24 |

Response: `{ data: OfferSummary[], nextCursor: string | null, facets: {...} }`.

### Scheduled report (bundled example)

`scripts/reports/` ships a ready-made "best computer-tech deals" report:

```bash
# read-only report → writes reports/tech-deals/<timestamp>/{report.md,offers.csv,offers.json}
bun run scripts/reports/tech-deals.ts --min-discount-bps 2000 --top 30

# cron/systemd wrapper: optionally refresh data first (REFRESH=1), then report
REFRESH=1 SCRAP_USER_AGENT="YourBot/1.0 (+https://you.example)" \
  ./scripts/reports/refresh-and-report.sh --min-discount-bps 2000
```

Schedule it with cron (daily 07:00):

```cron
0 7 * * * cd /path/to/scrapito && REFRESH=1 SCRAP_USER_AGENT="YourBot/1.0 (+https://you.example)" ./scripts/reports/refresh-and-report.sh >> /tmp/tech-deals.log 2>&1
```

---

## CLI reference — `scrap-ingest`

Invoke as `bun run ingest -- <args>` (or `bun run --filter @scrapito/ingest scrap-ingest <args>`).

| Command | Writes? | Purpose |
|---|:--:|---|
| `db migrate` | yes | apply pending migrations (idempotent) |
| `db reset --yes` | yes | DROP and recreate the database (destructive) |
| `browser install` / `browser doctor` | no | manage/verify agent-browser |
| `stores list` | no | list configured stores |
| `scrapers list` | no | list registered scrapers + their defaults |
| `scrapers validate <fileOrId>` | no | offline static + fixture validation (no network/browser) |
| `discover list` / `discover run <id>` | discover: yes | local-only reconnaissance; never auto-registers a scraper |
| `run <scraperId> [opts]` | **yes** | synchronous ingestion — the only command that saves products |
| `target run [file]` | **yes** | one typed target Invocation; category results include a handoff-ready `coverageId` |
| `offers query [opts]` | no | offer search via `GET /offers` |
| `offers handoff <coverageId> [opts]` | no | exact sighted data via `GET /coverages/:coverageId/offers` |

Registered scrapers: `ripley-pe`, `falabella-pe` (`fixture-products` is
test-only). Stores: `ripley-pe`, `falabella-pe`.

---

## HTTP API reference

All routes are `GET`. Standard resources use `{ data }`; `/offers` uses
`{ data, nextCursor, facets }`; the coverage handoff is its schema-valid
`CoverageOfferHandoff`; failures use `{ error: { code, message, details? } }`.

| Route | Returns |
|---|---|
| `/health` | `{ data: { status: "ok" } }` |
| `/stores` | configured stores |
| `/categories?store=` | categories (placeholder) |
| `/products?store=&cursor=&limit=` | product page (keyset) |
| `/products/:id` | product detail + active variants |
| `/products/:id/prices` | price observations |
| `/offers?...` | offer search (see filters above) |
| `/offers/:productId/history` | offer/price history |
| `/coverages/:coverageId/offers?cursor=&limit=` | exact evidence-backed offers sighted by one coverage |
| `/updates?store=&cursor=&limit=` | recent ingestion runs |
| `/freshness` | data age per store |
| `/images/:sha256` | image bytes (64-hex sha) |

---

## Configuration (environment variables)

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `SCRAP_DB_PATH` | catalog (read+write) | `./data/scrap.sqlite` | shared SQLite file |
| `SCRAP_STORAGE_DIR` | ingest, api | `./storage` | content-addressed image bytes |
| `SCRAP_USER_AGENT` | ingest | — | **required** for `run`/`discover`; must be honest |
| `SCRAP_DISCOVERY_DIR` | ingest | `./data/discovery` | discovery artifacts |
| `AGENT_BROWSER_BIN` | ingest | `node_modules/.bin/agent-browser` | browser binary |
| `AGENT_BROWSER_DEFAULT_TIMEOUT` | ingest | `25000` | per-op timeout (ms) |
| `AGENT_BROWSER_LIVE` | ingest | — | gate for `test:live` |
| `SCRAP_HOST` / `SCRAP_PORT` | api | `127.0.0.1` / `3000` | API bind address |
| `SCRAP_PUBLIC_READS` | api | `false` | must be exactly `true` to bind a non-loopback host |
| `WEB_ORIGIN` | api | — | comma-separated exact origins allowed by CORS (GET/HEAD/OPTIONS only) |
| `SCRAP_API_BASE_URL` | ingest (`offers query` / `offers handoff`) | `http://127.0.0.1:3000` | read-only API base for the CLI |
| `API_BASE_URL` | web (server) | — | **required**; server-only Hono API base for SSR |
| `VITE_PUBLIC_API_BASE_URL` | web (browser) | — | **required**; browser-visible Hono API base |

---

## Project layout

```
apps/
  api/      read-only Hono HTTP API      (src/app.ts routes, serve.ts, cors.ts)
  ingest/   scrap-ingest CLI + scrapers  (src/cli, policy, scrapers, images, discovery)
  web/      TanStack Start web app        (src/routes, src/lib api client)
packages/
  contracts/  shared Zod schemas/types/codecs (no bun:sqlite/fs/Hono/browser)
  catalog/    SQLite owner: read/ (readonly) + write/ (migrations, lease, stores)
scripts/
  reports/  ready-made report + cron wrapper
tests/
  integration/  cross-app pipeline + security/boundary tests
  live/         opt-in smoke tests against real sites (never in CI)
```

## Architecture

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

Every network call in `apps/ingest` flows through one policy chokepoint
(allowlist, robots.txt, circuit breaker, SSRF guard). Scrapers receive only a
registered id plus Zod-validated params — never source code, module paths, or
raw URLs.

## Package boundaries (enforced by `tests/integration/security.test.ts`)

- `apps/api` imports only `@scrapito/contracts` and `@scrapito/catalog/read` —
  never `@scrapito/catalog/write`, `@scrapito/ingest`, `agent-browser`,
  discovery, the scraper registry, or a scrape runner.
- `apps/ingest` imports `@scrapito/contracts` + both catalog subpaths — never
  `apps/api` or `apps/web`.
- `apps/web` imports only `@scrapito/contracts` — never `@scrapito/catalog` or
  `@scrapito/ingest`; every loader talks to `apps/api` over HTTP.
- `apps/ingest/src/scrapers/registry.ts` and `apps/ingest/src/discovery/**`
  never import each other — discovery is local-only, never server-reachable.

## How offers are classified

Every priced product is classified at query time (`deriveOffer` in
`@scrapito/contracts`, mirrored by the `current_offers` SQL view): the
effective price is the lower of `offerCents ?? regularCents` and `cardCents`
(ties prefer the public price). `verified_discount` requires a positive
`regularCents` strictly above the effective price; a card/promo price without a
trustworthy regular price is `promotional_price`; a row with neither an offer
nor a card price is not an offer. Card-only pricing is disclosed via
`priceAccess: "card"` and separately filterable.

---

## Testing

```bash
bun run typecheck            # every workspace package
bun run test                 # unit tests (all packages) + tests/integration
bun run test:integration     # cross-app pipeline + security/boundary tests
bun run test:live            # opt-in: AGENT_BROWSER_LIVE=1 + SCRAP_USER_AGENT (never CI)
bun run build:web            # apps/web client + SSR bundle
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `WRITER_LOCKED` | Another `run`/`discover` holds the lease. Wait for it to finish; never run two at once. |
| `DB_NOT_READY` / "pending migrations" | Run `bun run db:migrate` first. |
| `POLICY_DENIED` on `run` | `SCRAP_USER_AGENT` is unset, or the target host is not allowlisted. |
| API returns empty `/offers` | The catalog has no data yet — run an ingestion pass. |
| API won't bind a public host | Set `SCRAP_PUBLIC_READS=true` (loopback-only otherwise). |
| Web app throws on startup | Both `API_BASE_URL` and `VITE_PUBLIC_API_BASE_URL` must be set. |
| `CIRCUIT_OPEN` / `BUDGET_EXHAUSTED` / `CHALLENGE_DETECTED` | Expected policy back-pressure during scraping; retry later or lower the budget. |

For architecture, conventions, and contributor guidance see
[`AGENTS.md`](./AGENTS.md).
