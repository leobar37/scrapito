---
id: P-008
phase_type: integration
title: Expose Evidence-Backed Data Handoff
status: completed
entry_criteria: P-007 has proven one-shot target execution, exact coverage provenance, catalog sightings and read-only API boundaries end-to-end
exit_criteria: An external caller can run a supported target, take its non-null coverageId, and page the exact evidence-backed offer set sighted by that coverage through neutral catalog, HTTP and CLI read contracts
dependencies: [P-007]
requirements: [FR-018, FR-019, FR-020, NFR-002, NFR-006, NFR-007, NFR-009, NFR-011, NFR-012]
subagent: task
---

# P-008 Expose Evidence-Backed Data Handoff

## Objective

Exponer un handoff read-only, neutral y respaldado por evidencia para consumidores externos. El caller ejecuta primero un target one-shot, conserva el `coverageId` no nulo del resultado y consulta después únicamente las ofertas sighted en esa coverage. Precio e identidad mutable (`name`, `brand`, URL y seller) se fijan en el sighting observado. Scrapito gestiona scrapers, persistencia y datos; el agente externo posee selección, consumo LLM, Discord, rendering, delivery, idempotencia y scheduling.

## Phase Type

integration

## Entry Criteria

- `P-007` está `completed` y prueba target run one-shot, coverage/sightings, single-writer y terminación limpia.
- Category targets producen `coverageId`; los caminos legacy, search o cualquier ejecución con `coverage: null` no pueden construir el handoff.
- La API continúa abriendo exclusivamente `@scrapito/catalog/read`.

## Exit Criteria

- `EvidenceBackedOffer` y `CoverageOfferHandoff` son contratos runtime-neutral, schema-valid y sin conceptos de selección, LLM, Discord o delivery.
- `CatalogQueries.getCoverageOfferHandoff(coverageId, { cursor, limit })` une exactamente coverage → run/target → sightings → products → el `price_observation_movements` cuyo id coincide con `sighting.price_observation_id`; usa snapshots inmutables del sighting para name/brand/URL/seller y nunca metadata mutable/latest global.
- El envelope expone `invocationId`, `runId`, `site`, metadata de coverage, `data` y `nextCursor` opaco.
- Paginación keyset estable usa `(productId, sightingId)` y conserva coverage partial/failure tal como fue registrada.
- Coverage inexistente, run legacy sin `invocationId` o coverage con sightings legacy sin snapshot de identidad falla con diagnóstico claro; no existe fallback silencioso a `products`.
- `GET /coverages/:coverageId/offers` valida path/query/response y permanece read-only.
- `scrap-ingest offers handoff <coverageId> --limit/--cursor/--api-base-url --json` refleja el endpoint, emite exactamente un JSON y preserva `offers query`.
- Un target run con coverage no nula encadena por `coverageId` al conjunto exacto sin fuga de observaciones ni metadata de productos de runs posteriores.

## Subagent Prompt

```text
Implementa P-008 como un handoff de datos evidence-backed y read-only. Define contratos neutrales EvidenceBackedOffer y CoverageOfferHandoff. El caller externo ejecuta target run, toma coverageId y consulta el conjunto exacto sighted por esa coverage. Une product_sightings.price_observation_id con price_observation_movements.id; nunca uses latest global. Captura también name, brand, canonical URL y seller id/name inmutables dentro del sighting al persistir ProductInput. Incluye identidad estable de producto/tienda, PEN, observación exacta, efectivo/acceso/stock, movimiento, lows y evidencia de sighting.

Añade una migración aditiva de data para snapshots nullable + version marker en product_sightings. Filas legacy quedan sin versionar y hacen el handoff unavailable; no inventes exactitud usando products mutable. CatalogStore llena snapshots de runs nuevos dentro de la misma transaction. Añade CatalogQueries.getCoverageOfferHandoff, GET /coverages/:coverageId/offers y scrap-ingest offers handoff. Valida schemas y errores de coverage/cursor/limit/snapshot legacy. Preserva partial. Prueba migración temp/idempotente, precio y metadata sin later-leak, cursor, API 200/400/404/read-only, CLI fake, integración target-run→coverageId→handoff y graph security.

No implementes selección, consumidor LLM, apps/agent, .omp, Discord, webhook, renderer, delivery ledger ni scheduler. No abras una nueva superficie de escritura: la captura ocurre exclusivamente en el CatalogStore existente durante la ingesta.
```

## Requirements Covered

- `FR-018`, `FR-019`, `FR-020`
- `NFR-002`, `NFR-006`, `NFR-007`, `NFR-009`, `NFR-011`, `NFR-012`

## Dependencies

- `P-007`

## Files or Areas Involved

- `packages/contracts/src/` - Modify - neutral evidence-backed offer/envelope and pagination input schemas.
- `packages/catalog/src/migrations/` y `write/catalog-store.ts` - Modify - migración aditiva y captura transaction-local del snapshot de identidad.
- `packages/catalog/src/read/` - Modify - exact coverage-scoped read query, rechazo legacy y opaque keyset cursor.
- `apps/ingest/src/cli/` - Modify - HTTP client command under existing `offers`; no catalog writes.
- Focused tests and `README.md` - Modify/Create - exact provenance, read-only boundary, two-step flow and external ownership.

## Expected Outcome

```text
external caller
  ├─ 1. scrap-ingest target run manifest.json → InvocationResult.coverage.coverageId
  └─ 2. GET /coverages/{coverageId}/offers (or offers handoff) → CoverageOfferHandoff
       └─ external agent owns selection → LLM → rendering → Discord/delivery
```

## Context to Preserve

- Scrapito owns scrapers, target execution, SQLite data and neutral reads only.
- The external agent owns selection criteria, the LLM consumer, Discord, renderer, delivery, ledger, retries, schedules, batches and priority.
- `scrap-ingest` remains the only catalog writer; the new API/CLI path is read-only.
- Coverage provenance and immutable sighting snapshots are the isolation boundary; later price or product metadata must not alter an older handoff.

## Constraints

- Una sola migración aditiva de data puede extender `product_sightings`; no modifica migraciones históricas ni backfillea metadata actual como si fuera histórica.
- No `apps/agent`, `.omp`, Discord, webhook, renderer, delivery ledger, scheduler or resident process changes; no nueva API de catálogo write.
- Currency is literal `PEN`; amounts are integer cents.
- Cursor is opaque, coverage-bound and stable over `(productId, sightingId)`.
- Category is initially the usable target path because it produces coverage. Search/legacy results with `coverage: null` are explicitly unavailable.
- No use of `data/scrap.sqlite`, real network, commit or stash during implementation/validation.

## Completion Criteria

- Contract tests accept complete neutral envelopes and reject malformed identity, price, movement, evidence, coverage and cursor fields.
- Temp SQLite test prueba observación y metadata exactas: coverage 1 ve identity v1, un run posterior muta el mismo externalId a v2 y el handoff anterior conserva v1.
- Migración `0009` aplica en DB temporal, re-run es no-op y filas legacy sin snapshot hacen el handoff unavailable.
- API proves 200, 400, 404 and failed write method without mutating SQLite.
- CLI proves URL/query construction, fake-server response/error handling and exactly one JSON output while `offers query` remains intact.
- Integration proves target-run output `coverageId` can retrieve exactly that run’s sighted offers.
- Security graph proves API does not reach writer, ingest runtime, agent, Discord, webhook or delivery modules.
- Focused tests, root typecheck, agent build and full test suite are green.

## Validation

- `bun test packages/contracts/src/coverage-handoff.test.ts`
- `bun test packages/catalog/src/coverage-offer-handoff.test.ts`
- `bun test apps/api/src/app.test.ts`
- `bun test apps/ingest/src/cli/offers-handoff.test.ts`
- `bun test tests/integration/scrape-runner-coverage.test.ts tests/integration/security.test.ts`
- `bun run typecheck`
- `bun run build:agent`
- `bun test`

## Expected Final Report

- Contratos y forma exacta del envelope.
- Evidencia de join por `sighting.price_observation_id`, identity snapshot transaction-local y ausencia de later-leak.
- Semántica de cursor, partial y errores missing/run legacy/sighting legacy.
- Resultado API/CLI/integración/security.
- Confirmación de ownership externo para selection/LLM/Discord/delivery y ausencia de cambios fuera de scope.

## Risks or Notes

- `coverageId` es requisito del handoff. Category lo produce hoy; `coverage: null` de search/legacy no tiene evidencia suficiente y falla explícitamente.
- Sightings anteriores a `0009` permanecen sin snapshot: su handoff falla cerrado. Backfillear desde `products` actual atribuiría metadata posterior y está prohibido.
- Una coverage partial sigue siendo valiosa como evidencia observada, pero el envelope conserva `status` y `authoritative` para que el consumidor externo decida cómo usarla.
- El cursor incorpora coverage para impedir reutilización accidental entre conjuntos.
