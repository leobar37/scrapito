# Agentic Catalog Maintenance Phase Index

## Summary

- Mode: Structured
- Slug: `agentic-catalog-maintenance`
- Requirements File: `requirements.md`
- Phase State: `phases/*.md` frontmatter
- Durable phases: 8
- Ownership: external infrastructure defines jobs/schedule/retries/batches/priority; Scrapito executes explicit Invocations only

## Requirements Coverage

| Requirement | Covered By |
| --- | --- |
| `FR-001` | `phases/03-run-measurable-target-coverage.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `FR-002` | `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md` |
| `FR-003` | `phases/03-run-measurable-target-coverage.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md` |
| `FR-004` | `phases/02-establish-target-observation-foundation.md`, `phases/03-run-measurable-target-coverage.md` |
| `FR-005` | `phases/03-run-measurable-target-coverage.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `FR-006` | `phases/01-settle-minimal-price-history-design.md`, `phases/02-establish-target-observation-foundation.md` |
| `FR-007` | `phases/01-settle-minimal-price-history-design.md`, `phases/02-establish-target-observation-foundation.md` |
| `FR-008` | `phases/01-settle-minimal-price-history-design.md`, `phases/02-establish-target-observation-foundation.md` |
| `FR-009` | `phases/01-settle-minimal-price-history-design.md`, `phases/02-establish-target-observation-foundation.md` |
| `FR-010` | `phases/01-settle-minimal-price-history-design.md`, `phases/02-establish-target-observation-foundation.md` |
| `FR-011` | `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `FR-012` | `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md` |
| `FR-013` | `phases/05-enable-gated-scraper-repair.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `FR-014` | `phases/05-enable-gated-scraper-repair.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `FR-015` | `phases/03-run-measurable-target-coverage.md`, `phases/06-operate-capacity-inactivity-and-retention.md` |
| `FR-016` | `phases/02-establish-target-observation-foundation.md`, `phases/06-operate-capacity-inactivity-and-retention.md` |
| `FR-017` | `phases/06-operate-capacity-inactivity-and-retention.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `FR-018` | `phases/01-settle-minimal-price-history-design.md`, `phases/06-operate-capacity-inactivity-and-retention.md`, `phases/08-expose-evidence-backed-data-handoff.md` |
| `FR-019` | `phases/08-expose-evidence-backed-data-handoff.md` |
| `FR-020` | `phases/08-expose-evidence-backed-data-handoff.md` |
| `NFR-001` | `phases/02-establish-target-observation-foundation.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `NFR-002` | `phases/03-run-measurable-target-coverage.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/06-operate-capacity-inactivity-and-retention.md`, `phases/08-expose-evidence-backed-data-handoff.md` |
| `NFR-003` | `phases/03-run-measurable-target-coverage.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md` |
| `NFR-004` | `phases/04-deliver-one-shot-omp-coordination.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `NFR-005` | `phases/05-enable-gated-scraper-repair.md`, `phases/07-prove-agentic-maintenance-end-to-end.md` |
| `NFR-006` | `phases/01-settle-minimal-price-history-design.md`, `phases/02-establish-target-observation-foundation.md`, `phases/06-operate-capacity-inactivity-and-retention.md`, `phases/08-expose-evidence-backed-data-handoff.md` |
| `NFR-007` | `phases/02-establish-target-observation-foundation.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md`, `phases/08-expose-evidence-backed-data-handoff.md` |
| `NFR-008` | `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md` |
| `NFR-009` | `phases/01-settle-minimal-price-history-design.md`, `phases/06-operate-capacity-inactivity-and-retention.md`, `phases/08-expose-evidence-backed-data-handoff.md` |
| `NFR-010` | `phases/03-run-measurable-target-coverage.md`, `phases/04-deliver-one-shot-omp-coordination.md`, `phases/05-enable-gated-scraper-repair.md` |
| `NFR-011` | `phases/08-expose-evidence-backed-data-handoff.md` |
| `NFR-012` | `phases/08-expose-evidence-backed-data-handoff.md` |

## Phase List

| Phase ID | Type | File | Purpose | Dependencies |
| --- | --- | --- | --- | --- |
| `P-001` | investigation | `phases/01-settle-minimal-price-history-design.md` | Cerrar contrato mínimo aditivo para sightings, change-log, caída y mínimo | none |
| `P-002` | implementation | `phases/02-establish-target-observation-foundation.md` | Persistir identidades target, coverage, membership y sightings sin scheduling | `P-001` |
| `P-003` | implementation | `phases/03-run-measurable-target-coverage.md` | Entregar Invocation/target contracts y capability matrix determinista con soporte real verificado | `P-002` |
| `P-004` | implementation | `phases/04-deliver-one-shot-omp-coordination.md` | Entregar wrapper OMP completo que consume manifest externo y compone Site×Strategy×Capability | `P-003` |
| `P-005` | implementation | `phases/05-enable-gated-scraper-repair.md` | Entregar repair explícito con candidate, approval hash-bound, promotion, canary y rollback | `P-003`, `P-004` |
| `P-006` | implementation | `phases/06-operate-capacity-inactivity-and-retention.md` | Exponer métricas, inactividad y retención one-shot sin planificación interna | `P-002`, `P-003` |
| `P-007` | integration | `phases/07-prove-agentic-maintenance-end-to-end.md` | Probar Invocations, composición, writes seriales y repair de extremo a extremo | `P-005`, `P-006` |
| `P-008` | integration | `phases/08-expose-evidence-backed-data-handoff.md` | Exponer handoff read-only exacto y evidence-backed por coverage para consumidores externos | `P-007` |

## Suggested Execution Order

1. `P-001` fija la transición de histórico.
2. `P-002` crea la base de observación, dejando target como identidad sin scheduler.
3. `P-003` define y prueba el contrato determinista que `P-004` debe envolver: Invocation, target schemas, Site/Strategy/Capability y support matrix.
4. `P-004` implementa el runtime OMP completo sobre contratos ya verificados; no puede preceder a `P-003`.
5. `P-006` puede avanzar en paralelo con `P-004` y `P-005` después de `P-003`, porque expone métricas/maintenance explícitos sin seleccionar trabajo.
6. `P-005` requiere capability matrix y wrapper para repair.
7. `P-007` integra y valida adquisición, histórico y reparación.
8. `P-008` añade después el borde neutral de datos: el caller toma `coverageId` y consulta el conjunto sighted exacto.

## Parallelization and Ownership Notes

- Infraestructura externa mantiene ownership exclusivo de jobs/schedule/retries/batches/priority.
- Scrapito no persiste Invocation como queue; `invocationId` solo correlaciona auditoría/resultados.
- Analysis/worktrees pueden ser paralelos. Promotion al checkout principal e ingesta siempre pasan por write gate 1.
- `P-003` y `P-004` deben compartir un único contrato `InvocationContext`/`InvocationResult`; se prohíbe mantener aliases JobContext/JobResult.
- `.omp/agents` contiene tres roles genéricos. La variación site/strategy/capability vive en definitions/prompts composables del wrapper.
- `P-008` no introduce selección ni delivery: Scrapito expone datos neutrales; el agente externo posee selección, LLM, Discord, renderer, ledger y transporte.

## Open Decision Deadlines

- Support matrix inicial y evidencia real por combinación: cerrar en `P-003`.
- Provider/model profiles/hard cost cap: cerrar antes de completar `P-004`.
- Owner/hito del switch de auto-promotion: cerrar antes de production promotion de `P-005`; default humano.
- Targets adicionales con coverage no nula se evalúan después de `P-008`; category es el camino inicial y `coverage: null` queda no disponible.

## Plan Validation Gate

### Risk Trigger

El plan cruza manifest externo, OMP, tres tiendas, browser/red, SQLite, histórico y reparación/promoción de código. P-008 agrega un read model por coverage. Riesgos: ownership difuso, combinaciones declaradas sin soporte, bypass de policy, aprobación stale, colisión single-writer y fuga desde latest global hacia evidencia histórica.

### Requirement Coverage

- Todos los `FR-001`–`FR-020` y `NFR-001`–`NFR-012` tienen fase propietaria y validación final.
- La decisión final está incorporada: ownership externo; Invocation one-shot; ausencia de due selection/registry; Site×Strategy×Capability; roles OMP genéricos; repair explícito y approval hash-bound; P-008 depende de P-007 y limita Scrapito al handoff evidence-backed read-only.

### Phase Exit Criteria

- Frontmatter preserva IDs/status y dependencias sin ciclos.
- DAG: `P-001 → P-002 → P-003 → P-004 → P-005`; `P-003 → P-006`; `{P-005,P-006} → P-007 → P-008`.
- Cada fase conserva requirements, prompt, validation y reporte agente-sized.

### Dependency Risks

- `P-004` está bloqueada hasta que `P-003` pruebe Invocation/matrix real.
- `P-005` no puede reparar una combinación no declarada/verificada en matrix.
- `P-006` no puede inferir inactividad sin coverage autoritativa, pero tampoco puede seleccionar cuándo ejecutarse.
- `P-008` requiere que `P-007` pruebe un target run con coverage y sightings; no implementa selección ni entrega.

### Contract Risks

- Riesgo de reintroducir jobs usando target cadence/due fields: bloqueado por FR-004/NFR-002 y tests de ausencia.
- Riesgo de agentes cartesianos: bloqueado por NFR-010 y estructura esperada.
- Riesgo de approval stale: mitigado vinculando hashes de candidate/diff/evidencia/checks/canary y revalidando después de promotion.
- Riesgo worktree/registry: el canary debe cargar el scraper estáticamente registrado desde el código del worktree, nunca source dinámico.
- Riesgo de fuga temporal: mitigado uniendo el sighting a su `price_observation_id` y snapshots de identidad inmutables, nunca al latest ni a metadata mutable de `products`.
- Riesgo de reutilizar cursor entre conjuntos: mitigado con cursor opaco ligado a coverage y keyset `(productId, sightingId)`.

### Validation Gaps

- Soporte real homepage/trending por tienda debe probarse en `P-003`; combinaciones sin evidencia quedan unsupported, no placeholders.
- Model IDs y switch de promotion siguen siendo inputs operativos con defaults seguros.
- Search/legacy con `coverage: null` no bloquea `P-008`: el handoff comienza únicamente donde coverage existe (category).

### Rollback and Recovery

- `scrap-ingest` manual permanece fallback determinista.
- Migraciones son aditivas.
- Auto-promotion está off durante baseline.
- Candidate aprobado no puede cambiar; hash mismatch fuerza nueva aprobación.
- Canary fallido revierte promotion y devuelve resultado; no agenda retry.
- El handoff no tiene estado que recuperar: el caller puede repetir la misma lectura por coverage y cursor.

### Delegation Readiness

Fases están agent-sized. La infraestructura externa puede ejecutar fases, pero el producto resultante no gestiona sus jobs ni consumidores. `P-003` es contract/integration foundation; `P-004` es runtime wrapper; `P-005` es repair lifecycle; `P-008` es el borde read-only de datos y comienza tras la prueba integral de `P-007`.

### Blocking Questions

No hay bloqueo arquitectónico. Support matrix, modelos/cap, owner de switch y targets futuros con coverage se resuelven en deadlines explícitos; category habilita el handoff inicial.

### Decision

**Approve with operational inputs.** El plan refleja ownership externo y puede ejecutarse desde `P-001`; ninguna fase implementa scheduling, selección de ofertas, LLM consumidor, Discord o delivery dentro de Scrapito.
