# Agentic Catalog Maintenance Context

## Overview

Scrapito evolucionará de una CLI de ingesta manual a una **capability CLI one-shot** invocable mediante una intención y target explícitos. La infraestructura externa —otro sistema o agente— es la única dueña de jobs, schedule, retries, batches, prioridad e idempotencia global. Scrapito no define ni selecciona trabajo pendiente: valida una `Invocation`, compone las capacidades necesarias, ejecuta una vez y devuelve un `InvocationResult` machine-readable antes de terminar.

La nueva CLI embebe OMP SDK, usa un coordinador pequeño configurable y compone agentes/modelos especializados desde tres dimensiones independientes:

```text
SiteDefinition × StrategyDefinition × CapabilityDefinition
```

- `SiteDefinition`: conocimiento estable de Ripley, Falabella o Promart.
- `StrategyDefinition`: comportamiento reutilizable de homepage, trending, category o product.
- `CapabilityDefinition`: operación permitida, inicialmente inspect, acquire, repair o verify.

No se crean agentes por producto cartesiano site×strategy. `.omp/agents` contiene únicamente roles genéricos (`site-agent`, `repair-agent`, `verifier`); el wrapper compone prompts base + site + strategy + capability y pasa contexto/schema tipado en cada Invocation.

La finalidad sigue siendo adquirir y mantener datos e histórico verificables. Como integración final acotada, Scrapito expondrá un handoff neutral read-only del conjunto exacto sighted por una `coverageId`. Scrapito gestiona scrapers y datos; el agente externo posee selección, consumidor LLM, Discord, renderer, delivery, idempotencia y retries.

## Background

El estado actual impone límites que el plan preserva:

- `apps/ingest/src/app/scrape-runner.ts` ejecuta una corrida síncrona por invocación.
- `apps/ingest/src/cli/index.ts` adquiere el lease y expone `run` con resultado JSON tipado.
- `packages/catalog/src/migrations/0002_remove_job_queue.sql` eliminó deliberadamente `scrape_jobs` y creó el lease single-writer.
- `packages/catalog/src/write/writer-lease.ts` define un lease global `catalog-ingest`; no existe paralelismo seguro de escrituras por tienda.
- `apps/ingest/src/scrapers/registry.ts` registra scrapers revisados para Ripley, Falabella y Promart.
- Los scrapers aceptan categoría, búsqueda y URLs internamente, pero homepage/trending y producto individual aún no son targets deterministas de negocio de primera clase en la CLI.
- `packages/catalog/src/write/catalog-store.ts` trata `price_observations` como change-log: inserta solo cuando cambia precio/stock/vendedor.
- `packages/catalog/src/migrations/0004_offer_search.sql` deriva ofertas actuales, pero aún no expresa caída frente a la observación anterior ni mínimo histórico.

OMP fue verificado para este diseño: `createAgentSession`, agentes de proyecto en `.omp/agents`, selección de model/thinking/tools/output por agente, límites task para concurrencia/request budget/runtime/profundidad y aislamiento con worktrees. Worktree no es sandbox de red/SO; la seguridad también exige custom business tools y paths restringidos.

## Goal

Al completar el plan, la infraestructura externa podrá enviar un manifest explícito como:

```text
InvocationContext {
  invocationId,
  intent,
  site,
  strategy,
  target,
  constraints,
  repairPolicy
}
```

Scrapito validará que la combinación Site×Strategy×Capability esté realmente soportada, ejecutará análisis permitidos, serializará promoción e ingesta, y devolverá un `InvocationResult` con estado, coverage, run, repair, artefactos y usage. Cuando el resultado contenga `coverageId`, el caller podrá consultar después un `CoverageOfferHandoff` exacto y evidence-backed. No habrá job registry, selección de targets due, selección de ofertas, delivery ni mantenimiento diario interno.

Una oferta real seguirá significando una caída estricta del precio efectivo frente a la observación de precio anterior; se indicará además si establece un mínimo histórico estricto.

## Key Decisions

- La infraestructura externa posee jobs, schedule, retries, batches, prioridad y próxima acción.
- Scrapito expone `scrap-agent invoke` one-shot con manifest JSON/stdin y resultado JSON estable.
- `invocationId` es correlación del caller, no una fila consumida por worker.
- Un target persistido, si existe para coverage/sightings, es identidad canónica/auditable; no incluye `enabled`, cadence, priority, `next_due_at` ni semántica de scheduler.
- El coordinador pequeño procesa una Invocation ya definida; no descubre targets due ni planifica un día.
- `SiteDefinition` contiene store/scraper/hosts/canonicalización/repair roots/contexto estable y adapters soportados.
- `StrategyDefinition` contiene target schema, coverage semantics y prompt reutilizable.
- `CapabilityDefinition` contiene state machine, tools y output de inspect/acquire/repair/verify.
- `.omp/agents` se limita a `site-agent`, `repair-agent` y `verifier`; prompts composables viven en `apps/agent/src/prompts/{sites,strategies,capabilities}`.
- `acquire` no inicia reparación implícita. Repair requiere `intent: repair` o autorización explícita `allowRepair` en el manifest.
- Repairs usan worktree; el scraper sigue en registry estático. El canary debe ejecutar el worktree sin registrar dinámicamente source remoto.
- Candidate, approval y promotion son artefactos distintos. La aprobación referencia hashes inmutables del candidate/diff, fixtures, validaciones y canary; cualquier cambio de hash invalida la aprobación.
- Aprobación humana es obligatoria durante baseline. Después, un switch operativo puede autorizar solo promotion low-risk local tras todos los gates.
- Análisis/worktrees pueden ser paralelos; promoción al checkout principal e ingesta pasan por write gate 1 y luego por el WriterLease existente.
- `scrap-ingest` permanece como único writer del catálogo.
- `price_observations` se preserva como change-log y `product_sightings` referencia su observación vigente.
- El handoff para consumidores se expresa con `EvidenceBackedOffer` y `CoverageOfferHandoff`; fija precio por el `price_observation_id` y name/brand/URL/seller por snapshots versionados del sighting, nunca por latest ni metadata mutable global.
- La paginación read-only usa cursor opaco ligado a coverage y keyset `(productId, sightingId)`.
- La migración aditiva deja snapshots legacy en null y esos handoffs fallan cerrado; no se backfillea identidad desde el estado actual de `products`.
- Selección, consumo LLM, Discord, rendering, delivery, ledger, retries y scheduling pertenecen al agente externo; Scrapito no implementa esos bordes.

## Scope Boundaries

- In scope: Invocation CLI/schema/result; manifest externo; Site×Strategy×Capability; tres SiteDefinitions; strategies reutilizables; capability matrix determinista; OMP genérico; model routing; custom tools; repair explícito con worktree, approval hash-bound, promotion/canary/rollback; coverage/sightings/histórico; métricas por Invocation; inactividad/retención mediante invocaciones administrativas explícitas; handoff neutral read-only exacto por coverage.
- Out of scope: job registry, scheduler, selección de targets due, daily-maintenance, retry orchestration de Invocations, batches internos, prioridad interna, selección/recomendación de ofertas, consumidor LLM, Discord entrante o saliente, webhook, renderer, delivery ledger, múltiples transports, UI, login/checkout, bypass anti-bot, worker/queue residente y reemplazo destructivo del histórico.

## Evidence Classification

### Verified

- El lease de escritura es global, no por tienda.
- `price_observations` es change-gated.
- Los tres scrapers viven en subtrees estables y están registrados estáticamente.
- OMP ofrece sesión, agentes, routing, límites e isolation/worktrees requeridos.
- La frontera read-only de coverage más snapshots inmutables del sighting permite entregar evidencia exacta sin abrir escritura ni transferir selección/delivery a Scrapito.

### Inferred

- Separar Site/Strategy/Capability evita prompts y agentes duplicados y permite ampliar tiendas o estrategias con una sola dimensión nueva.
- El manifest externo elimina la ambigüedad de ownership y evita reintroducir scheduler/queue bajo otro nombre.
- Separar datos evidence-backed de todos los consumidores conserva reutilización futura y evita acoplar catálogo, API o `scrap-ingest` a selección, LLM, Discord o delivery.

### Unknown / Operational Inputs

- Proveedor, IDs de modelo y hard cost cap para coordinator/site, repair y verify.
- Support matrix inicial exacta por tienda, especialmente homepage/trending y boundary autoritativo de category.
- Owner y momento operativo del switch de auto-promoción low-risk.
- Targets adicionales que producirán coverage no nula; P-008 funciona inicialmente donde existe coverage (category), mientras search/legacy con `coverage: null` queda no disponible.
