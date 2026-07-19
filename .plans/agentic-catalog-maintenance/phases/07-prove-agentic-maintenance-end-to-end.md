---
id: P-007
phase_type: integration
title: Prove Invocation Capabilities End to End
status: completed
entry_criteria: P-005 and P-006 are completed and external manifests, support matrix, models, approval owner, and safe defaults are available
exit_criteria: Evidence proves explicit Invocations, composition, capability support, serialized writes, hash-bound repair, retention, rollback, and consumer-neutral outputs across all sites
dependencies: [P-005, P-006]
requirements: [FR-001, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006, NFR-007, NFR-008, NFR-009, NFR-010]
subagent: integration-reviewer
---

# P-007 Prove Invocation Capabilities End to End

## Objective

Validar desde manifest externo hasta `InvocationResult`: contract/matrix, tres SiteDefinitions, strategies/capabilities reutilizables, roles OMP genéricos, límites, write gate, histórico, repair explícito hash-bound, inactividad y retention one-shot. Probar ausencia de job registry/scheduler/due selection es criterio de release.

## Phase Type

integration

## Entry Criteria

- `P-005` y `P-006` están `completed`.
- Provider/model profiles y hard cap configurados.
- Capability matrix y approval owner documentados.
- Auto-promotion off salvo test controlado.

## Exit Criteria

- Matrix end-to-end pasa para toda combinación declarada supported.
- Unsupported falla antes de side effects.
- Candidate/approval/promotion/canary/rollback fueron ejercitados.
- No existen agents site×strategy, JobContext/JobResult, registry/due planner ni consumers.
- Plan Validation Gate final emite release decision.

## Subagent Prompt

```text
Valida agentic-catalog-maintenance end-to-end usando manifests externos explícitos. Recorre cada capability matrix cell supported y confirma fail-fast para unsupported. Verifica que SiteDefinition×StrategyDefinition×CapabilityDefinition compone solo site-agent/repair-agent/verifier y prompts site/strategy/capability. Ejecuta acquire/inspect con DB/storage temporal y canary acotado; prueba price sequences/sightings/coverage. Ejecuta repair explícito: reproduction, worktree candidate, static registry canary, verifier, approval hashes, promotion y rollback; tampea cada hash para comprobar invalidación. Demuestra analysis paralelo y writer max 1. Inyecta policy/lease/challenge/budget/time/cost errors. Verifica métricas sin scheduling y retention solo explícita. Busca/niega JobContext, JobResult, job registry, due/cadence/priority planner, retry loop, agents cartesianos y consumers. No inventes live success si policy bloquea.
```

## Requirements Covered

- `FR-001`, `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-007`, `FR-008`, `FR-009`
- `FR-011`, `FR-012`, `FR-013`, `FR-014`, `FR-015`, `FR-016`, `FR-017`, `FR-018`
- `NFR-001`, `NFR-002`, `NFR-003`, `NFR-004`, `NFR-005`, `NFR-006`, `NFR-007`, `NFR-008`, `NFR-009`, `NFR-010`

## Dependencies

- `P-005`
- `P-006`

## Files or Areas Involved

- `apps/agent/` - Review/Integrate - Invocation, composition, prompts, tools, repair y write gate.
- `.omp/agents/` - Review - exactamente roles genéricos esperados.
- `apps/ingest/src/` - Review/Integrate - targets, registry, runner, policy y writer CLI.
- `packages/catalog/src/` - Review/Integrate - observations/history/retention.
- `packages/contracts/src/` - Review - Invocation schemas.
- `tests/integration/`, `tests/live/` - Modify/Run - scenarios.

## Expected Outcome

- Release candidate que expone capabilities seguras a infraestructura externa sin convertirse en job system.
- Evidence matrix requirement→scenario→result.

## Context to Preserve

- CLI manual determinista como fallback.
- Ningún agente escribe catálogo directamente.
- Auto-promotion default off.
- Consumers solo leen contratos neutrales.

## Constraints

- Live canaries con budgets mínimos/user-agent honesto.
- No dos writes simultáneos.
- No retries/Invocations implícitas.
- Worktree no se afirma como OS/network sandbox.
- No release sin evidencia por supported cell.

## Completion Criteria

- External manifest→single InvocationResult funciona y termina.
- Support matrix y composition probadas.
- Search/architecture check confirma ausencia de conceptos prohibidos.
- Cost cap corta antes de write y writer trace max 1.
- Price/drop/low, inactivity y retention equivalence pasan.
- Repair hash tampering, approval, static registry canary y rollback pasan.
- Plan Validation Gate final approve o block con blockers.

## Validation

- Tests focalizados y al final `bun run typecheck` + `bun run test` una vez.
- Smoke CLI file/stdin/stdout.
- Canary live bounded donde policy permita.
- Process cleanup: sin worker/server.
- `node ./planner-checklist.js list agentic-catalog-maintenance`.

## Expected Final Report

- Requirement/evidence y capability matrix results.
- Invocation/composition proof.
- Tests/typecheck/smoke/live exactos.
- Concurrency/cost/write evidence.
- Repair hashes/approval/rollback evidence.
- Final gate/release decision.

## Risks or Notes

- Policy block es evidencia válida, no algo a evadir.
- Suite verde sin manifest smoke y tamper/rollback no satisface fase.
