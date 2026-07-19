---
id: P-006
phase_type: implementation
title: Expose Invocation Metrics Inactivity and Retention
status: completed
entry_criteria: P-002 persists normalized observations and P-003 emits trustworthy Invocation coverage and target metrics
exit_criteria: Invocation results expose capacity evidence, inactivity is deterministic, and retention runs only by explicit one-shot administrative invocation without internal planning
dependencies: [P-002, P-003]
requirements: [FR-015, FR-016, FR-017, FR-018, NFR-002, NFR-006, NFR-007, NFR-009]
subagent: task
---

# P-006 Expose Invocation Metrics Inactivity and Retention

## Objective

Exponer métricas por Invocation para que infraestructura externa planifique; implementar inactividad basada en coverage autoritativa y retención/compaction solo como capability/comando administrativo explícito. Scrapito no calcula targets due, prioridad, batches ni schedule diario.

## Phase Type

implementation

## Entry Criteria

- `P-002` y `P-003` están `completed`.
- Coverage complete/partial y authoritative membership son confiables.
- InvocationResult tiene envelope extensible de métricas.

## Exit Criteria

- Cada Invocation reporta requests/duración/writer/productos/duplicates/rejects/LLM usage.
- Inactividad/reactivación respeta evidencia autoritativa.
- Ofertas stale/inactive se filtran correctamente.
- Retention se invoca explícitamente, con dry-run/batches/lease y sin proceso residente.

## Subagent Prompt

```text
Implementa P-006 sin planner interno. Añade métricas observadas a InvocationResult para que el caller externo decida schedule, retries, batches y prioridad. Implementa inactividad solo desde coverage complete+authoritative o señales explícitas; homepage/trending/partial nunca incrementan misses. Reactiva con sighting válido y filtra ofertas stale. Conserva price_observations indefinidamente; compacta sightings iguales según policy sin cambiar drops/lows. Expón retention como Invocation/capability o comando administrativo one-shot explícito con dry-run, bounded batch y lease. No selecciones targets due, no priority×age, no daily loop, no scheduler/worker. Outputs neutrales; sin consumers.
```

## Requirements Covered

- `FR-015`, `FR-016`, `FR-017`, `FR-018`
- `NFR-002`, `NFR-006`, `NFR-007`, `NFR-009`

## Dependencies

- `P-002`
- `P-003`

## Files or Areas Involved

- `packages/contracts/src/` - Modify - InvocationResult metrics y administrative request/result.
- `packages/catalog/src/write/` - Modify - compaction/inactivity bajo lease.
- `packages/catalog/src/read/queries.ts` - Modify - activity/freshness/drop-ready readers.
- `apps/agent/src/capabilities/` - Modify - explicit administrative retention binding si aplica.
- `apps/ingest/src/cli/index.ts` - Modify - one-shot retention/dry-run si es la frontera elegida.
- `tests/integration/` - Modify - inactivity, stale filter, retention y no-scheduling.

## Expected Outcome

- Caller externo recibe evidencia de capacidad, sin que Scrapito decida cuándo repetir.
- Histórico compacto/exacto y catálogo vigente.
- Maintenance explícito y auditable, no diario implícito.

## Context to Preserve

- `price_observations` change-log indefinido.
- Productos con histórico no se hard-deletean.
- Single-writer también aplica a compaction.
- Discord/recommendations/UI fuera de scope.

## Constraints

- Sin fields/algoritmos due/cadence/priority/batch planning.
- Inactive membership default solo tras evidencia completa configurada; homepage/trending nunca por ausencia.
- Rollups no cambian secuencia histórica.
- Retention dry-run y bounded batch; ninguna tarea automática.

## Completion Criteria

- Metrics tienen unidades/denominadores estables por Invocation.
- Partial/failed no desactiva; complete authoritative sí según policy.
- Stale/inactive fuera de current offers con transición compatible.
- Compaction preserva history/drop/low.
- Búsqueda de código/tests demuestra ausencia de scheduler/due selector.

## Validation

- Clocked tests de misses/reactivation/freshness.
- Before/after retention comparando history/drops/lows.
- Dry-run, bounded batch, lease contention e idempotencia.
- Contract tests de InvocationResult metrics.
- Test explícito de que ninguna métrica agenda nueva Invocation.

## Expected Final Report

- Métricas expuestas y semántica.
- Inactividad/reactivación.
- Retention/compaction equivalence.
- Evidencia de ausencia de planning interno.
- Validaciones y riesgos.

## Risks or Notes

- Capability administrativa debe distinguirse de site strategies; no introducir un scheduler encubierto.
- Thresholds operativos son config, pero el caller decide cuándo invocar.
