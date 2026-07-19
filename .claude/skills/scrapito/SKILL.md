---
name: scrapito
description: "Operate Scrapito's Peru offer catalog and one-shot external-agent handoff for Ripley, Falabella, and Promart. Use for scrapito, scan store, scrape, ofertas, offers, price drop, coverage handoff, external agent, escanear tienda, adquirir catálogo, historial de precios, retention, or capacity metrics."
allowed-tools: Read, Bash
---

# Scrapito operator skill

Operate from the repository root with **Bun**. This is an operator guide, not a license to change application code.

## Current contract

- Stores: `ripley-pe`, `falabella-pe`, `promart-pe`.
- Registered production scrapers: `ripley-pe-products`, `falabella-pe-products`, `promart-pe-products`. `fixture-products` is test-only.
- Every monetary amount is an integer in **céntimos PEN** (`150000` = S/ 1,500.00). Never rewrite internal values as decimal soles.
- `scrap-ingest` is synchronous and one-shot. It is the only catalog writer and holds a SQLite writer lease.
- `apps/api` and every offer/coverage handoff are read-only.
- The external caller owns target selection, schedule, retries, batches, priority, idempotency across invocations, recommendation/selection, rendering, Discord, and delivery.

## Non-negotiable boundaries

1. Never run two ingest, discovery, retention, promotion, or other writer operations concurrently. On `WRITER_LOCKED`, wait; do not bypass the lease.
2. Never open SQLite directly, import catalog packages, write scripts against the DB, or mutate through the API. Use the host CLIs and GET API only.
3. Never pass arbitrary URLs, module paths, source, or scraper IDs from a caller. Accept only a typed manifest and the closed static matrix.
4. Never invent or export a false `SCRAP_USER_AGENT`; use an operator-supplied honest identity. Never set `AGENT_BROWSER_LIVE` or run live/network checks unless the operator explicitly requests them.
5. Never edit production scraper files. Repair is explicit, isolated, hash-bound, human-approved, promoted by a configured host gate, and canaried/rolled back by that host.
6. Never run `db migrate`, `db reset`, or migrate a real data DB without an explicit operator decision. `DB_NOT_READY` is a stop condition, not permission to migrate.
7. Never add scheduling, retry loops, multi-target batches, Discord, selection, or delivery inside Scrapito.

## Safe read-only orientation

```bash
bun run ingest -- --help
bun run ingest -- scrapers list
bun run ingest -- target matrix
bun run ingest -- target run --help
bun run ingest -- offers handoff --help
bun run ingest -- maintenance retention --help
```

The matrix is authoritative. Today, for all three sites:

- `category × acquire` and `search × acquire` are supported.
- `category × repair` and `search × repair` are declared supported by evidence.
- `homepage`, `trending`, and `product` have no verified execution adapter.
- `inspect` and `verify` have no standalone supported matrix cells.
- Category acquisition creates coverage; search acquisition returns `coverage: null` and therefore cannot produce a coverage handoff.

## Choose the boundary

### Deterministic acquisition without OMP

```bash
bun run ingest -- target run invocation.json
# or: cat invocation.json | bun run ingest -- target run -
```

This validates one `InvocationContext`, performs at most one supported run, emits exactly one `InvocationResult` JSON line, and exits. It does not schedule or retry.

### OMP-coordinated maintenance/acquisition

```bash
bun run agent -- invoke invocation.json
# read-only preflight: no OMP, network, DB, or write
bun run agent -- invoke invocation.json --dry-run
```

The wrapper reuses the current user's standard **local OMP auth/model registry**; do not inject, copy, or log credentials. It disables OMP retry/async behavior, uses generic `site-agent`, `repair-agent`, and `verifier` roles, then serializes the host write path. `--fake` is test-only and must not be used as production evidence.

For the copy-paste category/acquire manifest and complete caller protocol, read [references/external-agent-handoff.md](references/external-agent-handoff.md).

## Consume the result

Treat stdout as machine JSON and stderr as diagnostics.

- Terminal success: `status: "completed"`.
- `status: "partial"` is usable evidence, not full success. Preserve `coverage.status`, `authoritative`, `boundary`, and `stopReason`; external policy decides whether/when to retry.
- `status: "failed"` or `"rejected"`: record `error.code/message`; do not infer an empty catalog.
- Capacity evidence is in `usage`: `requests`, `durationMs`, `writerDurationMs`, `productsSaved`, `productsSeen`, `productsRejected`, `duplicatesSeen`, `imagesDownloaded`, and nullable LLM token/cost metrics.
- `coverage: null` means no handoff. Never substitute latest global offers.
- A non-null `coverage.coverageId` is the only key for exact sighted-data handoff.

## Read-only offers and history

With the API already operated by its owner:

```bash
curl 'http://127.0.0.1:3000/offers?store=promart-pe&sort=discount_desc&limit=20'
curl 'http://127.0.0.1:3000/offers/123/history'
curl 'http://127.0.0.1:3000/coverages/17/offers?limit=50'
bun run ingest -- offers handoff 17 --limit 50 --api-base-url http://127.0.0.1:3000 --json
```

`GET /offers` is the current promotional-offer view. `GET /offers/:productId/history` returns price observations plus `publicHistoricalLowCents` and `cardHistoricalLowCents`; it does **not** expose temporal drop, strict-low, or seller-change flags. Those flags belong to the coverage handoff, which freezes the exact sighting identity and price observation and must not be replaced with current product metadata or current price.

Follow opaque cursors exactly: request the next page only when `nextCursor` is non-null, using the same coverage and limit. Never decode, edit, reuse across coverages, or restart from page 1 and merge silently.

## Retention

Retention is an explicit, bounded writer invocation. The external operator chooses cutoff, batch size, repetition, and timing:

```bash
bun run ingest -- maintenance retention \
  --invocation-id retention-2026-07-18-001 \
  --sightings-before 2026-01-01T00:00:00.000Z \
  --batch-size 1000 --dry-run
```

Even dry-run opens the writer boundary and audit path: serialize it. Inspect `candidates`, `sightingsDeleted`, `priceObservationsDeleted` (must be `0`), `hasMore`, and `replayed`. A later non-dry run requires explicit operator approval. Scrapito never schedules the next batch.

## Repair boundary

A repair manifest requires `intent: "repair"`, `repairPolicy.allowRepair: true`, and reproducible SHA-256-bound evidence. Candidate, diff, fixtures, checks, canary, and approval hashes are immutable; any mismatch invalidates approval. Baseline promotion requires a human approval and host-side serialized gate.

The stock `bun run agent -- invoke` entrypoint currently has no production repair executor configured and fails closed with `REPAIR_EXECUTOR_UNAVAILABLE`. Do not work around this by editing production. Only a separately configured host repair CLI may create an isolated candidate and request approval; it must never expose generic Write/Edit/shell access to the model.

## Stop and escalate

- `WRITER_LOCKED`: another writer owns the lease; wait.
- `DB_NOT_READY`: ask the operator to decide on migration.
- `POLICY_DENIED`: require the operator's honest user-agent or reject the target.
- `BUDGET_EXHAUSTED`, `CHALLENGE_DETECTED`, `CIRCUIT_OPEN`: preserve partial/error evidence; external infra decides retry timing.
- `COVERAGE_NOT_FOUND`, `COVERAGE_HANDOFF_UNAVAILABLE`, `INVALID_CURSOR`, `BAD_API_RESPONSE`: fail closed; never fall back to current offers.
