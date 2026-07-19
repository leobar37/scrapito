---
id: P-003
phase_type: implementation
title: Establish Deterministic Invocation Capability Matrix
status: completed
entry_criteria: P-002 provides target identities, coverage, memberships, sightings, and run provenance without scheduling semantics
exit_criteria: Typed Invocation and target contracts plus a verified SiteDefinition by StrategyDefinition by CapabilityDefinition matrix exist for all truthfully supported combinations
dependencies: [P-002]
requirements: [FR-001, FR-003, FR-004, FR-005, FR-015, FR-016, NFR-002, NFR-003, NFR-010]
subagent: task
---

# P-003 Establish Deterministic Invocation Capability Matrix

## Objective

Crear el contrato determinista que consumirá el wrapper: `InvocationContext`, `InvocationResult`, target schemas discriminados, tres `SiteDefinition`, strategies reutilizables y una capability matrix que declare únicamente soporte real verificado. Esta fase no implementa OMP ni scheduling.

## Phase Type

implementation

## Entry Criteria

- `P-002` está `completed`.
- Targets persistidos son identidades auditables, no unidades due/schedulables.
- Existen fixtures y scrapers registrados para las tres tiendas.

## Exit Criteria

- Manifest JSON/stdin y resultado JSON tienen Zod schemas versionados.
- Site×Strategy×Capability falla temprano para combinaciones unsupported.
- Cada combinación soportada tiene fixture/test o canary real acotado.
- Target adapters emiten args deterministas para `scrap-ingest`, sin URL/comando libre.

## Subagent Prompt

```text
Implementa P-003 sin OMP. Define InvocationContext/InvocationResult para una llamada one-shot externa; no JobContext/JobResult, registry, due selection, cadence, retries, batches ni prioridad. Modela SiteDefinition estable para ripley-pe, falabella-pe y promart-pe; StrategyDefinition reutilizable para homepage, trending, category y product; CapabilityDefinition para inspect, acquire, repair y verify; y una support matrix explícita. Cada SiteDefinition aporta scraperId registrado, hosts, canonicalización, repair roots, prompt/context refs y adapters por strategy. Cada StrategyDefinition aporta target schema, coverage semantics y boundary. Verifica cada combinación declarada con fixture/test o canary; deja unsupported lo no probado. Produce mapping determinista a business CLI y métricas de InvocationResult. No crees agentes site×strategy ni edites consumers.
```

## Requirements Covered

- `FR-001`, `FR-003`, `FR-004`, `FR-005`, `FR-015`, `FR-016`
- `NFR-002`, `NFR-003`, `NFR-010`

## Dependencies

- `P-002`

## Files or Areas Involved

- `packages/contracts/src/` - Modify - Invocation, target, capability matrix y result schemas neutrales.
- `apps/ingest/src/cli/index.ts` - Modify - machine contract determinista si falta.
- `apps/ingest/src/scrapers/{ripley-pe,falabella-pe,promart-pe}/` - Modify - adapters/fixtures por strategy.
- `apps/ingest/src/scrapers/registry.ts` - Review - solo IDs estáticos; no registro dinámico.
- `apps/ingest/src/policy/` - Review - preservar policy.
- `tests/integration/` y `tests/live/` - Modify - matrix/support evidence.

## Expected Outcome

- La infraestructura externa puede construir una Invocation explícita sin conocer URLs internas por tienda.
- `P-004` recibe un manifest y una matrix cerrados, no inventa target resolution.
- Capability support es una afirmación probada, no un placeholder.

## Context to Preserve

- Scrapers registrados estáticamente y budgets lower-only.
- Homepage/trending no son membership autoritativa.
- Category complete exige boundary verificable.
- Product target acepta externalId o URL canónica validada.

## Constraints

- `invocationId` es correlación externa, no job PK.
- Prohibidos fields de schedule/due/retry/batch/priority en Invocation o target identity.
- No agentes/prompts OMP en esta fase.
- No combinar site y strategy en tipos/agentes duplicados; usar adapters.

## Completion Criteria

- Schemas rechazan intent/site/strategy/target inválidos y unknown fields.
- Matrix rechaza side effects antes de iniciar OMP/red/write.
- Ripley/Falabella/Promart tienen SiteDefinition y repair roots exactos.
- Cada strategy tiene target/coverage contract reutilizable.
- `InvocationResult` reporta run/coverage/artifacts/usage/error sin decidir siguiente Invocation.

## Validation

- Contract tests JSON file/stdin y stdout de una línea.
- Matrix table tests para supported/unsupported por site/strategy/capability.
- Fixture/canary por cada supported acquire/inspect combination.
- Tests host/path mismatch, boundary, empty/partial y budgets.
- Typecheck/test focalizado de contracts e ingest.

## Expected Final Report

- Invocation schemas y ejemplos.
- Tres SiteDefinitions, cuatro StrategyDefinitions y cuatro CapabilityDefinitions.
- Capability matrix con evidencia por celda.
- Combinaciones unsupported y razón.
- Validaciones y blockers para `P-004`.

## Risks or Notes

- No declarar homepage/trending soportado si solo existe una URL supuesta.
- Repair support indica que existe scope/reproduction path; promotion se implementa en `P-005`.
