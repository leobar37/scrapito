---
id: P-001
phase_type: investigation
title: Settle Minimal Price History Design
status: completed
entry_criteria: Existing catalog schema, price derivation, write path, and history readers are available for inspection
exit_criteria: An approved additive data contract defines sightings, effective-price drops, historical lows, reader transition, and whether a view or event is justified
dependencies: []
requirements: [FR-006, FR-007, FR-008, FR-009, FR-010, FR-018, NFR-006, NFR-009]
subagent: plan
---

# P-001 Settle Minimal Price History Design

## Objective

Cerrar, con evidencia del esquema y queries actuales, el contrato de datos mínimo que preserva `price_observations` como change-log, añade sightings sin duplicar el vector de precio y deriva correctamente caída real y mínimo histórico. La fase debe decidir si basta una vista calculada o si un evento persistido está realmente justificado.

## Phase Type

investigation

## Entry Criteria

- El repositorio y migraciones actuales están disponibles.
- Las decisiones de scope en `context.md` y requirements están aceptadas.
- No se ha iniciado una migración que reemplace `price_observations`.

## Exit Criteria

- Existe un decision record aprobado con esquema lógico, invariantes y transición de readers.
- La primera observación, precio igual, subida, caída y nuevo mínimo tienen comportamiento inequívoco.
- Se documenta por evidencia la elección vista vs evento; sin evidencia, se elige vista.
- Quedan definidos backfill, compatibilidad, rollback y queries de validación para `P-002`.

## Subagent Prompt

```text
Actúa como arquitecto de datos para Scrapito. Lee context.md y requirements.md. Investiga únicamente el modelo actual de productos, price_observations, deriveOffer/current_offers, histórico y escritura de snapshots. Diseña una transición aditiva que preserve price_observations como change-log e introduzca product_sightings referenciando la price observation vigente. Define precio efectivo usando la semántica existente; caída real es current effective < previous effective y la primera observación no cae. Define is_historical_low como nuevo mínimo estricto. Compara vista SQL calculada vs evento persistido usando duplicación, auditoría, rendimiento, paginación y consumidores futuros; elige evento solo con justificación demostrable. Entrega decision record, esquema lógico, invariantes, backfill/rollback, impacto en readers y matriz de pruebas. No edites aplicación ni amplíes scope a Discord, recomendaciones o UI.
```

## Requirements Covered

- `FR-006`, `FR-007`, `FR-008`, `FR-009`, `FR-010`, `FR-018`
- `NFR-006`, `NFR-009`

## Dependencies

- None.

## Files or Areas Involved

- `packages/catalog/src/migrations/0001_init.sql` - Review - esquema histórico de productos y precios.
- `packages/catalog/src/migrations/0004_offer_search.sql` - Review - vistas actuales de latest price/current offers.
- `packages/catalog/src/write/catalog-store.ts` - Review - `samePrice` y `maybeInsertPrice` change-gated.
- `packages/catalog/src/read/queries.ts` - Review - histórico y current offer readers.
- `packages/contracts/src/offers.ts` - Review - semántica vigente de `deriveOffer`/precio efectivo.
- `packages/contracts/src/dtos.ts` y `schemas.ts` - Review - contratos públicos impactados.

## Expected Outcome

- Modelo mínimo: target/coverage/run/sighting/membership con una referencia estable a la `price_observation` vigente.
- Contrato de caída/mínimo listo para migración e implementación sin almacenar dos veces cada vector de precio.
- Estrategia de transición que conserva readers existentes hasta que los nuevos estén verificados.

## Context to Preserve

- PEN y céntimos.
- Change gating de `price_observations`.
- Histórico actual y compatibilidad de API/read package.
- Neutralidad frente a consumidores futuros.

## Constraints

- No reemplazar ni renombrar destructivamente `price_observations`.
- No crear un evento persistido de caída por conveniencia; justificarlo con evidencia.
- No confundir oferta promocional estática con caída temporal.
- No diseñar Discord, recomendaciones o UI.

## Completion Criteria

- Decision record aprobado con alternativas y tradeoffs.
- Diagrama de relaciones y cardinalidades sin campos duplicados innecesarios.
- Reglas de comparación secuencial, sellers/stock/nulls y min histórico definidas.
- Plan de migración/backfill/read cutover reversible.
- Matriz de pruebas que fallaría ante duplicación o semántica incorrecta.

## Validation

- Trazar casos sobre fixtures/filas reales: primera observación, mismo vector, stock-only change, subida, caída, empate con mínimo y nuevo mínimo.
- Verificar que un sighting repetido referencia la misma `price_observation` vigente.
- Ejecutar consultas exploratorias read-only o pruebas temporales; no mutar la DB de trabajo.
- Confirmar que todos los readers afectados tienen transición y rollback.

## Expected Final Report

- Evidencia y símbolos inspeccionados.
- Decisión vista vs evento y por qué.
- Contrato final de entidades/campos/invariantes.
- Transición/backfill/rollback.
- Matriz de validación.
- Riesgos y decisiones operativas restantes.

## Risks or Notes

- La vista con ventanas SQL puede ser suficiente y es el default de mínima duplicación.
- Un evento persistido exige estrategia contra drift entre change-log y evento.
- Cambios de seller o stock deben permanecer en el change-log aunque no sean una caída de precio.
