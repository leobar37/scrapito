---
id: P-002
phase_type: implementation
title: Establish Target Observation Foundation
status: completed
entry_criteria: P-001 is completed with an approved additive schema and reader transition
exit_criteria: Targets, coverage, memberships, sightings, drop/low semantics, and run provenance persist through additive migrations without regressing existing history
dependencies: [P-001]
requirements: [FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-016, NFR-001, NFR-006, NFR-007]
subagent: task
---

# P-002 Establish Target Observation Foundation

## Objective

Implementar la base de persistencia y contratos para targets, cobertura, memberships y `product_sightings`, preservando `price_observations` como change-log y materializando solo la representación de caída/mínimo aprobada en `P-001`.

## Phase Type

implementation

## Entry Criteria

- `P-001` está `completed`.
- El contrato de vista/evento, backfill y transición está aprobado.
- La DB de prueba puede migrarse desde todas las versiones soportadas.

## Exit Criteria

- Migraciones aditivas e idempotentes crean el modelo acordado.
- Un snapshot produce sighting y referencia la observación de precio vigente.
- Runs y coverage capturan target, límites y stop reason.
- Readers antiguos y nuevos pasan tests de compatibilidad.

## Subagent Prompt

```text
Implementa P-002 siguiendo el contrato aprobado en P-001. Agrega migraciones nuevas; nunca edites migraciones históricas. Preserva price_observations como change-log y añade product_sightings que referencien la price observation vigente, además de targets, coverage y membership. Extiende run provenance y contratos/read-write stores de forma aditiva. Implementa caída real y mínimo histórico exactamente como decidió P-001, prefiriendo vista si fue la decisión. Migra/backfill DBs existentes sin pérdida y conserva readers durante el cutover. Escribe tests de comportamiento de migración, idempotencia, sighting sin cambio, caída/subida/igualdad, histórico y cobertura autoritativa. No introduzcas runtime OMP, Discord, recomendaciones ni UI. No ejecutes formateadores ni suite global; valida solo paquetes y tests afectados.
```

## Requirements Covered

- `FR-004`, `FR-005`, `FR-006`, `FR-007`, `FR-008`, `FR-009`, `FR-010`, `FR-016`
- `NFR-001`, `NFR-006`, `NFR-007`

## Dependencies

- `P-001`

## Files or Areas Involved

- `packages/catalog/src/migrations/` - Likely Create - migración aditiva posterior a `0006`.
- `packages/catalog/src/rows.ts` - Modify - row shapes nuevas/aditivas.
- `packages/catalog/src/write/catalog-store.ts` - Modify - vincular sighting con price observation vigente dentro de la transacción.
- `packages/catalog/src/write/run-store.ts` - Modify - provenance y métricas target/coverage.
- `packages/catalog/src/read/queries.ts` - Modify - readers de target, coverage, sightings y drop/low.
- `packages/contracts/src/` - Modify - schemas y DTOs runtime-neutral.
- `packages/catalog/src/smoke.test.ts`, `tests/integration/pipeline.test.ts` - Modify - regresiones de persistencia y transición.

## Expected Outcome

- Fuente de verdad mínima y normalizada para saber qué target vio qué producto, bajo qué cobertura y con qué observación de precio vigente.
- Change-log histórico intacto y semántica observable de caída/mínimo.
- Base suficiente para ejecutar targets y medir inactividad sin inferencias peligrosas.

## Context to Preserve

- `CatalogStore.productSnapshot` mantiene transacciones cortas sin I/O de red.
- El lease global sigue protegiendo toda escritura.
- API/read packages no obtienen capacidades de escritura.
- Tests de fronteras de import siguen pasando.

## Constraints

- La referencia de sighting a price observation debe ser no ambigua incluso cuando no se inserta precio nuevo.
- Un run parcial nunca genera cobertura `complete` por defecto.
- Homepage/trending debe quedar marcado como membership no autoritativa.
- Una identidad target puede deduplicar coverage/sightings, pero no contiene `enabled`, prioridad, cadencia, `next_due_at`, retry ni estado de queue.
- No duplicar raw price JSON en sightings.
- No hard-deletear histórico durante backfill.

## Completion Criteria

- Migración desde DB existente y migración limpia producen el mismo esquema final.
- Repetir el mismo vector añade sighting, no price observation ni drop.
- Una caída estricta y un nuevo mínimo se derivan correctamente.
- Membership misses solo pueden avanzar desde coverage completa/autoritativa.
- Queries y DTOs nuevos tienen validación runtime.

## Validation

- Tests de migración limpia, upgrade y re-ejecución idempotente.
- Tests transaccionales de `productSnapshot` con primera observación, repeat, subida, caída, stock y seller.
- Tests de readers actuales y nuevos, incluyendo histórico y ofertas.
- `bun run --filter @scrapito/contracts test` y typecheck del paquete.
- `bun run --filter @scrapito/catalog test` y typecheck del paquete.
- Integración de pipeline focalizada contra DB temporal.

## Expected Final Report

- Migraciones y contratos agregados.
- Mapeo al decision record de `P-001`.
- Evidencia de compatibilidad/backfill.
- Tests y comandos ejecutados.
- Riesgos o blockers para `P-003`/`P-004`.

## Risks or Notes

- `dependencies` en frontmatter debe permanecer `[P-001]`; si el helper detecta drift, corregir antes de iniciar.
- La query de histórico/min puede requerir índice; cualquier materialización debe respetar la decisión de `P-001`.
