# Agentic Catalog Maintenance Requirements

## Objective

Construir una capability CLI agentic one-shot para adquirir, inspeccionar, reparar y verificar scrapers de Ripley, Falabella y Promart a partir de una intención/target explícitos definidos por infraestructura externa. Como integración final, Scrapito debe exponer el conjunto exacto de ofertas sighted por una coverage mediante contratos neutrales read-only. Scrapito gestiona scrapers y datos; el agente externo conserva selección, consumo LLM, Discord y delivery.

## Scope

- In scope: `InvocationContext`/`InvocationResult`; manifest externo; composición SiteDefinition×StrategyDefinition×CapabilityDefinition; targets homepage/trending/category/product; capabilities inspect/acquire/repair/verify; coverage, membership y sightings; caída/mínimo histórico; repair explícito, aprobación hash-bound y canaries; métricas por Invocation; inactividad/retención explícitas; handoff read-only exacto por `coverageId`.
- Out of scope: job registry, schedule, retries de Invocations, batches, prioridad, selección de targets due, daily-maintenance, selección/recomendación de ofertas, consumidor LLM, `apps/agent` para delivery, Discord, webhook, renderer, delivery ledger, UI, múltiples transports, worker/queue permanente y bypass de políticas de crawl.

## Functional Requirements

- `FR-001` - Infraestructura externa debe poder invocar una nueva CLI one-shot mediante un manifest explícito con `invocationId`, intent, site, strategy, target y constraints; la CLI debe devolver un resultado machine-readable y terminar.
- `FR-002` - El wrapper debe usar un coordinador pequeño configurable para procesar la Invocation y delegar a perfiles especializados site/routine, repair y verify sin inventar scheduling ni próximos targets.
- `FR-003` - El contrato debe llamarse `InvocationContext`/`InvocationResult`; cada agente debe recibir contexto mínimo estructurado y devolver output validado por schema con evidencia, decisión, riesgo y acción solicitada.
- `FR-004` - Deben existir target schemas discriminados y deterministas para homepage, trending, category y product; un target persistido es identidad/auditoría, no una unidad schedulable con prioridad/cadencia/due state.
- `FR-005` - El sistema debe declarar y verificar una capability matrix SiteDefinition×StrategyDefinition×CapabilityDefinition para los tres sites; una combinación no soportada debe fallar antes de iniciar OMP o red/escritura.
- `FR-006` - Cada producto visto debe producir un sighting ligero asociado a Invocation/run/coverage/target y referenciar la `price_observation` vigente sin duplicar innecesariamente el vector de precio.
- `FR-007` - `price_observations` debe preservarse como change-log compatible; cualquier evolución debe ser aditiva y mantener transición explícita para readers e histórico.
- `FR-008` - Una oferta real debe existir únicamente cuando el precio efectivo actual sea estrictamente menor que el de la observación anterior; la primera observación no marca caída.
- `FR-009` - Cada caída debe exponer si el precio efectivo actual establece un mínimo histórico estricto, preservando semántica vigente y PEN.
- `FR-010` - La representación de caída/mínimo debe minimizar duplicación: preferir vista y persistir evento solo si una investigación demuestra necesidad de auditoría, rendimiento o consumo incremental.
- `FR-011` - Análisis y patches de Invocations distintas pueden ejecutarse en paralelo; promotion e ingesta al catálogo deben ejecutarse de una en una.
- `FR-012` - Cada Invocation debe aplicar una state machine explícita que distinga accepted/preflight/analyzing/waiting_write/executing/evaluating y terminal completed/partial/deferred/blocked/failed/cancelled, con repair solo cuando el manifest lo autoriza.
- `FR-013` - Repair debe ser una capability explícita y modelar candidate, reproduction, isolated patch, validation, canary, independent verification, approval, promotion y rollback como estados/artefactos distinguibles.
- `FR-014` - Durante baseline toda promotion requiere aprobación humana ligada a hashes inmutables de candidate/diff/evidencia/validaciones/canary; después, un switch operativo puede auto-aprobar solo low-risk local y cualquier cambio de hash invalida aprobación.
- `FR-015` - Cada `InvocationResult` debe reportar coverage y capacidad observada: requests, duración, writer time, productos, duplicados, rechazos y usage/coste LLM, para que la infraestructura externa decida scheduling/batches/prioridad.
- `FR-016` - Inactividad solo puede inferirse desde coverage completa/autoritativa o señales explícitas; partial/failure o ausencia en homepage/trending no desactiva productos.
- `FR-017` - Retención/compaction debe preservar cambios de precio y ejecutarse únicamente mediante una invocación/comando administrativo one-shot explícito, nunca como mantenimiento diario interno.
- `FR-018` - El contrato de lectura debe permanecer neutral y exponer por `coverageId` únicamente productos sighted en esa coverage junto con la observación de precio exacta y snapshots inmutables de name/brand/URL/seller capturados en cada sighting.
- `FR-019` - Un caller externo debe poder ejecutar un target one-shot, tomar el `coverageId` no nulo del resultado y consultar un `CoverageOfferHandoff` schema-valid sin que Scrapito seleccione productos ni cree/calendarice un job.
- `FR-020` - Cada `EvidenceBackedOffer` debe incluir identidad de producto/tienda, vendedor, URL, PEN, observación/effective/access/stock exactos, movimiento y lows, más `sightingId`, `seenAt`, `coverageId` y `sourceHash`; el envelope debe conservar run/Invocation/coverage y paginar establemente.

## Non-Functional Requirements

- `NFR-001` - Mantener single-writer con write gate de capacidad 1 y lease global como defensa interproceso; `scrap-ingest` es el único writer de catálogo.
- `NFR-002` - La infraestructura externa es dueña exclusiva de jobs, schedule, retries, batches y prioridad; Scrapito no debe reintroducir registry, queue, scheduler, worker ni selector de targets due.
- `NFR-003` - Agentes operan con tools mínimas, sin shell/red/SQL de producción libres, respetando CrawlPolicy, allowlists, robots y challenge detection.
- `NFR-004` - La orquestación impone límites configurables de concurrencia, pasos/requests, runtime, profundidad, tokens y coste; hard cap detiene nuevas acciones antes de escribir.
- `NFR-005` - Repairs usan isolation/worktrees y almacenamiento temporal; worktree no se considera sandbox de SO/red.
- `NFR-006` - Migraciones/contratos son aditivos, idempotentes y compatibles; no se reemplazan tablas históricas sin backfill, transición y rollback.
- `NFR-007` - Toda decisión que conduce a escritura/promotion es trazable por invocationId, site, strategy, capability, target, modelo, evidencia, hashes, aprobación, presupuesto y resultado.
- `NFR-008` - Routine usa modelos baratos y no escala a repair ante policy, challenge, circuit, lease, empty legítimo o agotamiento normal de presupuesto.
- `NFR-009` - Arquitectura desacoplada de consumidores: catálogo, API y `scrap-ingest` entregan datos neutrales; selección, LLM, Discord, rendering, delivery, idempotencia y retry pertenecen exclusivamente al agente externo.
- `NFR-010` - `.omp/agents` contiene solo roles genéricos `site-agent`, `repair-agent`, `verifier`; prompts site/strategy/capability se componen desde el wrapper sin agentes site×strategy.
- `NFR-011` - El handoff debe ser read-only y unir `product_sightings.price_observation_id` con esa fila de `price_observation_movements`; metadata mutable se lee de snapshots versionados del sighting. Se prohíbe sustituir precio o identidad por latest/current global.
- `NFR-012` - La paginación debe ser keyset estable por `(productId, sightingId)`, con cursor opaco ligado a coverage; debe preservar status partial y fallar claramente para coverage inexistente o run legacy sin `invocationId`.

## Acceptance Criteria

- Un manifest externo ejecuta una Invocation y obtiene un único `InvocationResult`; no se crea job row, due state ni proceso residente.
- El wrapper no selecciona targets, no reintenta entre Invocations y no decide batches/prioridad.
- Los tres SiteDefinitions se componen con strategies/capabilities reutilizables; agregar una strategy no duplica tres agentes y agregar un site no duplica todos los roles OMP.
- La capability matrix rechaza combinaciones no soportadas antes de iniciar side effects y tiene evidencia real por combinación declarada.
- `.omp/agents` contiene únicamente roles genéricos; prompts composables viven bajo `apps/agent`.
- Tres análisis pueden avanzar en paralelo, pero un trace demuestra máximo una promotion/ingesta activa.
- Repetir precio crea sighting que referencia la observación vigente, sin nueva `price_observation` ni caída.
- Reducción estricta crea/exhibe caída; subida/igualdad no. Mínimo histórico solo para nuevo mínimo estricto.
- Repair no comienza sin manifest/autorización explícita y candidate reproducible.
- Canary ejecuta el código del worktree con registry estático, DB/storage temporales y sin registrar source remoto.
- Approval referencia hashes; mutar candidate/diff/evidencia/check/canary invalida promotion.
- Baseline exige aprobación humana; switch posterior solo habilita low-risk local.
- Partial/challenge/circuit/writer lock no provoca repair especulativo ni inactividad.
- `InvocationResult` reporta métricas suficientes para que infraestructura externa planifique.
- Retention preserva change-log/mínimos y solo corre por invocación administrativa explícita.
- Ninguna fase acopla catálogo, API o `scrap-ingest` a selección, LLM, Discord o delivery; esos comportamientos permanecen en el agente externo.
- Un target run con coverage no nula permite consultar exactamente sus productos sighted, la observación referenciada y la identidad observada, aun cuando un run posterior cambie precio o metadata del mismo externalId.
- Coverage partial conserva su status, authoritative, tiempos, boundary y stopReason en el envelope.
- Coverage inexistente, cursor inválido y run legacy sin `invocationId` fallan con errores claros y schema-valid.
- Sightings legacy sin snapshot de identidad hacen el handoff unavailable; no se backfillean desde `products` actual como si fuera evidencia histórica.
- API y CLI exponen el mismo `CoverageOfferHandoff`; la CLI emite exactamente un JSON y el endpoint no abre ninguna escritura.

## Technical Decisions Already Made

- Entrada pública: CLI one-shot `scrap-agent invoke` con JSON por archivo/stdin y JSON de resultado.
- `InvocationContext`/`InvocationResult` reemplazan `JobContext`/`JobResult`.
- Composición: SiteDefinition×StrategyDefinition×CapabilityDefinition.
- Sites iniciales: Ripley, Falabella y Promart. Strategies: homepage, trending, category, product. Capabilities: inspect, acquire, repair, verify.
- `.omp/agents`: `site-agent`, `repair-agent`, `verifier`; model override/routing y prompts composables son propiedad del wrapper.
- `scrap-ingest` permanece como único writer; write gate 1 serializa promotion e ingesta.
- Repair usa worktree, registry estático, approval hash-bound y canary temporal antes de production canary.
- `price_observations` permanece change-log; `product_sightings` referencia su fila vigente.

- El handoff por coverage es neutral y read-only; selección, LLM, Discord, rendering, delivery, ledger y retries son propiedad del agente externo y no se implementan en Scrapito.
- Precio e identidad se fijan por `product_sightings`: `price_observation_id` referencia movimiento y los snapshots versionados preservan name/brand/URL/seller; nunca se usa latest global ni metadata mutable para handoffs históricos.

## Constraints

- Bun/TypeScript y fronteras read/write existentes.
- PEN y céntimos.
- Solo scrapers registrados y targets/URLs validados por SiteDefinition/StrategyDefinition.
- No comandos destructivos ni SQL arbitrario expuestos a agentes.
- No editar migraciones históricas; agregar migraciones.
- No persistir scheduling dentro de targets, coverage o Invocation audit.
- El cursor del handoff es opaco, ligado a coverage y estable por `(productId, sightingId)`.
- Category es inicialmente el camino operativo con coverage; resultados search/legacy con `coverage: null` no tienen handoff disponible.

## Open Questions

- ¿Qué provider/model IDs y hard cost cap se asignan a coordinator/site, repair y verify?
- ¿Qué combinaciones iniciales de la capability matrix tienen evidencia real, especialmente homepage/trending por tienda?
- ¿Quién opera el switch de auto-promoción y qué métricas/hito cierran baseline?
- ¿Qué targets adicionales producirán coverage no nula en el futuro? P-008 funciona inicialmente con category; `coverage: null` permanece explícitamente no disponible.
