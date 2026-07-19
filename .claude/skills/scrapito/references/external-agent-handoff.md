# External-agent handoff

## Copy-paste category/acquire manifest

Save as `invocation.json`. The caller must generate a unique, stable `invocationId`; retry policy and idempotency remain outside Scrapito.

```json
{
  "schemaVersion": 1,
  "invocationId": "external-2026-07-18-ripley-tecnologia-001",
  "intent": "acquire",
  "site": "ripley-pe",
  "strategy": "category",
  "target": {
    "kind": "category",
    "externalId": "tecnologia"
  },
  "constraints": {
    "maxRequests": 40,
    "maxDurationMs": 60000,
    "pages": { "from": 1, "to": 3 },
    "downloadImages": false
  },
  "repairPolicy": {
    "allowRepair": false
  }
}
```

Allowed sites are `ripley-pe`, `falabella-pe`, and `promart-pe`. A category `externalId` is a store-relative category value: it must not start with `/` and must not contain a scheme, query, hash, or backslash. Do not accept a caller-provided URL or scraper ID. Caller budgets can only narrow the registered scraper ceiling.

Before any network or DB operation, inspect the closed matrix and optionally run the OMP wrapper's side-effect-free preflight:

```bash
bun run ingest -- target matrix
bun run agent -- invoke invocation.json --dry-run
```

A dry-run returns `status: "partial"` with a `dry_run` artifact by design; it proves contract/matrix acceptance, not acquisition.

## Execution choices

The operator supplies an honest user-agent. Never synthesize one in automation logs or manifests.

```bash
export SCRAP_USER_AGENT='OperatorBot/1.0 (+https://operator.example/bot-info)'

# Direct deterministic one-shot acquisition:
bun run ingest -- target run invocation.json

# Or OMP-coordinated one-shot invocation, reusing local OMP auth:
bun run agent -- invoke invocation.json
```

Use one path, not both, for the same intended run. Serialize all Scrapito writers. Capture exactly one stdout JSON line plus exit status; keep stderr separately. Do not wrap either command in an internal retry loop.

## InvocationResult protocol

1. Validate `schemaVersion === 1` and `invocationId` equals the request.
2. Persist the whole result as immutable evidence before making caller-side decisions.
3. Read `status`:
   - `completed`: the one-shot invocation completed.
   - `partial`: preserve all usable evidence and the stop boundary. Do not label it complete.
   - `failed` or `rejected`: persist `error`; do not call the handoff unless a valid non-null coverage is explicitly present and caller policy permits it.
4. Read capacity metrics from `usage`. Units are requests, milliseconds, product/image counts, token counts, and USD cost. Scrapito reports observations; the external platform owns capacity planning.
5. Inspect `coverage`:
   - `null`: stop the handoff flow. Search currently has no coverage even though acquisition is supported.
   - non-null: preserve `coverageId`, `status`, `authoritative`, `boundary`, `requests`, `productsSeen`, `duplicatesSeen`, `productsRejected`, and `stopReason`.
6. Category coverage is currently non-authoritative. Partial, failed, homepage, trending, or non-authoritative absence must never be used to deactivate a product.
7. Only the caller decides whether a later invocation is warranted. Do not ask Scrapito to select due targets, schedule work, batch categories, or deliver offers.

## Exact coverage handoff

The read-only API must already be running under its operator. Use the returned positive `coverageId` exactly:

```bash
bun run ingest -- offers handoff 17 \
  --limit 50 \
  --api-base-url http://127.0.0.1:3000 \
  --json

# Equivalent GET-only call:
curl 'http://127.0.0.1:3000/coverages/17/offers?limit=50'
```

A `CoverageOfferHandoff` contains:

- invocation/run/site and coverage status, authority, boundary, timestamps, and stop reason;
- `data[]` with immutable sighting name, brand, seller, canonical URL, exact price observation, movement/drop/low flags, and evidence IDs/hash;
- `currency: "PEN"` and integer `*Cents` values;
- nullable `nextCursor`.

A partial coverage may legitimately return a partial handoff. Preserve that status and boundary in downstream records; never present it as exhaustive.

### Cursor loop owned by the external caller

1. Start with no cursor and fixed `coverageId`/`limit`.
2. Consume and persist the page once.
3. If `nextCursor` is a string, send it unchanged as `--cursor` or `?cursor=` for the same coverage.
4. Stop only when `nextCursor` is `null`.
5. Do not decode cursors, reuse one on another coverage, change its bytes, or merge a restarted pagination silently. Deduplicate downstream only by evidence identity, not mutable URL/name/price.

## Nulls, empty pages, and errors

- `coverage: null`: no exact handoff exists; never query latest offers as a substitute.
- `data: []` with `nextCursor: null`: a valid empty page if the envelope is otherwise valid. It is not proof that the store has no products.
- Nullable price/seller/source fields mean unknown/not observed. Preserve `null`; never coerce to `0`, empty text, a store seller, or a fabricated hash.
- `COVERAGE_NOT_FOUND`: bad or unavailable coverage ID; fail closed.
- `COVERAGE_HANDOFF_UNAVAILABLE`: legacy/incomplete immutable sighting identity; fail closed rather than joining current product data.
- `INVALID_CURSOR` or `BAD_REQUEST`: reject the page request; do not restart and merge automatically.
- `API_REQUEST_FAILED` or `BAD_API_RESPONSE`: transport/schema failure. Persist the diagnostic; external retry policy decides what happens later.
- `WRITER_LOCKED`: wait for the existing writer; never start concurrent ingest.
- Challenge, circuit, budget, and policy failures are operational outcomes, not automatic repair triggers.

## Offers versus history

These are separate read-only contracts:

```bash
# Current promotional offers (not restricted to one coverage):
curl 'http://127.0.0.1:3000/offers?store=ripley-pe&sort=discount_desc&limit=20'

# Product price/offer movement history:
curl 'http://127.0.0.1:3000/offers/123/history'
```

`GET /offers/:productId/history` returns observations plus `publicHistoricalLowCents` and `cardHistoricalLowCents`; it does not return `isPriceDrop`, `isHistoricalLow`, or `sellerChanged`. Those temporal flags are available only on each evidence-backed item in a coverage handoff: `isPriceDrop` means current effective cents are strictly below the immediately previous effective cents, and `isHistoricalLow` means a strict new effective-price low. Preserve access (`public`/`card`), stock, seller-change, and null semantics when consuming that handoff.

## External ownership after handoff

After Scrapito returns neutral evidence, the external platform may apply its own selection policy, LLM, rendering, Discord transport, delivery ledger, and retry/idempotency. None of those should import Scrapito write code, mutate SQLite, or be added to Scrapito's ingestion/API processes.
