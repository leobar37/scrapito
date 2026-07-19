---
id: P-004
phase_type: implementation
title: Deliver One-Shot OMP Invocation Wrapper
status: completed
entry_criteria: P-003 has delivered versioned Invocation contracts, three SiteDefinitions, reusable strategies, capabilities, and a verified support matrix
exit_criteria: A one-shot CLI consumes an external manifest, composes generic OMP roles with site strategy capability prompts, serializes writes, emits InvocationResult, and exits
dependencies: [P-003]
requirements: [FR-001, FR-002, FR-003, FR-005, FR-011, FR-012, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-007, NFR-008, NFR-010]
subagent: task
---

# P-004 Deliver One-Shot OMP Invocation Wrapper

## Objective

Entregar `scrap-agent invoke`: una CLI one-shot que recibe manifest externo, valida la matrix, compone SiteDefinition×StrategyDefinition×CapabilityDefinition, levanta OMP con coordinador pequeño y roles genéricos, y devuelve `InvocationResult`. No selecciona targets ni administra jobs.

## Phase Type

implementation

## Entry Criteria

- `P-003` está `completed`.
- Invocation/matrix/target adapters están versionados y probados.
- Provider/model profiles y hard cost cap están disponibles antes de live completion.

## Exit Criteria

- JSON file/stdin produce un único resultado JSON y proceso limpio.
- `.omp/agents` contiene solo `site-agent`, `repair-agent`, `verifier`.
- Prompts base/site/strategy/capability se componen en `apps/agent`.
- Toolsets, budgets, schema validation y write gate 1 fallan cerrado.
- No existe registry, scheduler, due selector ni retry entre Invocations.

## Subagent Prompt

```text
Implementa P-004 sobre P-003. Crea una CLI one-shot que consume InvocationContext externo por archivo/stdin y devuelve InvocationResult. Usa createAgentSession y coordinador pequeño configurable. Define solo roles OMP genéricos site-agent, repair-agent y verifier con thinking/tools/output/spawns; compón prompt base + SiteDefinition + StrategyDefinition + CapabilityDefinition desde apps/agent/src/prompts. El wrapper resuelve model overrides. Expón custom business tools tipadas; sin shell/browser/web/MCP/SQL libres. Configura maxConcurrency=3, depth=2, runtime=60m, request budget y ledger host de tokens/coste. Rechaza matrix unsupported antes de side effects. Serializa promotion e ingest con gate 1 y ejecuta scrap-ingest --json como único writer. No selecciones targets, no reintentes Invocations, no persistas job state ni implementes daily-maintenance.
```

## Requirements Covered

- `FR-001`, `FR-002`, `FR-003`, `FR-005`, `FR-011`, `FR-012`
- `NFR-001`, `NFR-002`, `NFR-003`, `NFR-004`, `NFR-005`, `NFR-007`, `NFR-008`, `NFR-010`

## Dependencies

- `P-003`

## Files or Areas Involved

- `apps/agent/` - Likely Create - CLI, config, invocation, composition, sites, strategies, capabilities, prompts, tools, write gate y audit.
- `.omp/agents/site-agent.md` - Likely Create - rol genérico inspect/acquire.
- `.omp/agents/repair-agent.md` - Likely Create - rol genérico repair.
- `.omp/agents/verifier.md` - Likely Create - rol genérico independiente.
- `package.json`/workspace manifests - Modify - script y OMP pinned.
- `packages/contracts/src/` - Consume/Modify only versioned Invocation contracts from P-003.
- `apps/ingest/src/cli/index.ts` - Review/minimal machine-contract change only.

## Expected Outcome

- State machine por Invocation: accepted→preflight→analyzing→waiting_write→executing→evaluating→terminal; repair solo si intent/policy lo autoriza.
- Model routing: coordinator/site barato, repair capaz, verifier independiente.
- Un manifest externo determina trabajo; output permite al caller decidir siguiente acción.

## Context to Preserve

- `scrap-ingest run --json` y `WriterLease` son frontera de escritura.
- `WRITER_LOCKED`→deferred; policy/circuit/challenge→deferred/escalated; budget→partial.
- Worktree no concede red/shell.
- Discord/recommendations/UI fuera de scope.

## Constraints

- No JobContext/JobResult ni aliases; solo InvocationContext/InvocationResult.
- No `.omp/agents` por site o strategy.
- No fallback silencioso a modelo caro.
- No production write desde subagente; host-only gate.
- Una Invocation no crea otra Invocation.

## Completion Criteria

- Manifest inválido/unsupported termina antes de OMP/red/write.
- Tres analyses pueden correr; máximo writer observado es 1.
- Hard cap/timeout/schema failure cancelan antes de nueva escritura.
- Segundo proceso con lease ocupado devuelve deferred sin busy-retry.
- Audit incluye invocation/site/strategy/capability/model/usage/evidence/action IDs.

## Validation

- Fake provider/tools para composition, state y routing.
- Tests file/stdin/stdout, unknown fields y matrix fail-fast.
- Tests de concurrency 3/write 1, cost stop, timeout y cleanup.
- Test de ausencia de registry/due/schedule/retry loop.
- Smoke Invocation fixture y typecheck/test del workspace.

## Expected Final Report

- CLI/roles/prompts creados.
- Composition/routing/tool matrix.
- Límites y write trace.
- Invocation examples/results.
- Validaciones y riesgos para repair.

## Risks or Notes

- Defaults OMP deben sobrescribirse; OMP no aporta hard monetary cap global.
- P-004 ya no puede comenzar en paralelo con P-003: consume su matrix verificada.
