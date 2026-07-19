---
id: P-005
phase_type: implementation
title: Enable Explicit Hash-Bound Scraper Repair
status: completed
entry_criteria: P-003 verifies the requested site strategy repair combination and P-004 provides the Invocation wrapper, generic roles, scoped tools, and write gate
exit_criteria: An explicit repair Invocation produces a reproducible candidate, worktree canary, independent verification, hash-bound approval, serialized promotion, production canary, and rollback
dependencies: [P-003, P-004]
requirements: [FR-002, FR-003, FR-012, FR-013, FR-014, NFR-003, NFR-005, NFR-007, NFR-008, NFR-010]
subagent: task
---

# P-005 Enable Explicit Hash-Bound Scraper Repair

## Objective

Implementar repair como capability explícita solicitada por manifest, separando candidate, approval y promotion. Repair usa worktree, registry estático, canary temporal ejecutado desde el worktree, verificador independiente y aprobación ligada a hashes inmutables.

## Phase Type

implementation

## Entry Criteria

- `P-003` y `P-004` están `completed`.
- Matrix marca soportada la combinación site×strategy×repair solicitada.
- Toolsets, worktree y write gate fueron probados.
- Owner del approval/switch está definido antes de production promotion.

## Exit Criteria

- `intent: repair` recorre lifecycle completo; acquire no repara sin `allowRepair` explícito.
- Candidate incluye reproduction/evidence/diff/check/canary hashes.
- Approval firma/referencia esos hashes y se invalida ante cualquier cambio.
- Canary usa código del worktree con registry estático, DB/storage temporales.
- Promotion/production canary seriales y rollback ejercitado.

## Subagent Prompt

```text
Implementa P-005 como capability explícita. Estados/artefactos: requested, classified, reproduced, candidate_created, patched_in_worktree, offline_verified, worktree_canary_passed, independently_verified, awaiting_approval, approved, promoted, production_canary, healthy/rejected/rolled_back/escalated. La Invocation aporta site, strategy, target y evidencia/run refs; acquire no genera repair salvo allowRepair. Usa SiteDefinition para repair root exacto. El repair-agent genérico recibe prompts site+strategy+repair y solo modifica scraper/normalizer/tests/fixtures de esa tienda. Ejecuta canary desde el worktree usando scraper registrado estáticamente en ese checkout, nunca source/module path dinámico, con DB/storage/discovery temporales. Candidate calcula hashes de base commit, diff, artefactos, fixtures, checks y canary. Approval referencia todos; hash mismatch obliga nueva verificación/aprobación. Baseline humano; switch posterior solo low-risk. Verifier sin edit/write. Host serializa promotion y production run; fallo revierte. Sin retries/Invocations implícitas.
```

## Requirements Covered

- `FR-002`, `FR-003`, `FR-012`, `FR-013`, `FR-014`
- `NFR-003`, `NFR-005`, `NFR-007`, `NFR-008`, `NFR-010`

## Dependencies

- `P-003`
- `P-004`

## Files or Areas Involved

- `apps/agent/src/capabilities/repair.ts` - Likely Create - lifecycle.
- `apps/agent/src/repair/` - Likely Create - worktree, candidate, hashes, approval, promotion, rollback.
- `apps/agent/src/prompts/capabilities/repair.md` - Create - composable repair prompt.
- `.omp/agents/repair-agent.md`, `.omp/agents/verifier.md` - Modify - generic roles only.
- `apps/ingest/src/scrapers/<site>/` - Repair scope only.
- `apps/ingest/src/scrapers/registry.ts` - Review - static registration invariant.
- `tests/integration/` - Modify - lifecycle, hashes, worktree canary y rollback.

## Expected Outcome

- Repair artifact chain auditable: Invocation→reproduction→candidate hashes→verification→approval→promotion→canary.
- No stale approval ni source dinámico.
- Low-risk automation técnicamente posible, operativamente off durante baseline.

## Context to Preserve

- Discovery no auto-promueve/registra.
- CrawlPolicy aplica live inspection/ingest.
- Scrapers siguen estáticamente registrados.
- Infraestructura externa decide si emite repair Invocation o reintenta.

## Constraints

- Low-risk solo subtree de extracción/normalización/fixtures/tests de una tienda.
- Prohibidos policy/allowlist/robots/circuit/budgets/lease/migrations/contracts/registry/CLI/deps.
- Prohibidos CAPTCHA/stealth/login/checkout.
- Sin reproducción no hay candidate.
- Approval es content-addressed; no aprobación mutable por invocationId solamente.

## Completion Criteria

- Drift deliberado produce candidate reproducible por cada site soportado.
- Empty/policy/challenge/circuit/budget/lease no produce patch.
- Canary demuestra que registry estático carga el código del worktree.
- Verifier rechaza scope/hash/check mismatch.
- Approval baseline precede promotion y hash mutation la invalida.
- Promotion/write max 1 y canary failure rollback sin loop.

## Validation

- State transition tests para request/candidate/approval/promotion.
- Path/scope y static-registry tests.
- Hash tampering tests para diff/evidence/check/canary.
- Temp canary desde worktree, no checkout principal.
- Approval switch tests y independent verifier test.
- Production canary/rollback controlados.

## Expected Final Report

- Lifecycle y artefactos.
- Hash contract y approval evidence.
- Static registry/worktree canary proof.
- Scope low-risk y bloqueos.
- Promotion/rollback/write trace.
- Tests y riesgos.

## Risks or Notes

- Si promotion cambia el patch por conflicto/rebase, hashes cambian: revalidar y reaprove antes de production canary.
- Auto-promotion permanece off hasta baseline externo aprobado.
