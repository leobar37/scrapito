---
name: scrapito
description: Operar el catálogo scrapito de ofertas e-commerce Perú (Ripley PE, Falabella PE). Úsala para buscar ofertas, actualizar/scrapear el catálogo, escribir scripts contra la base de datos, o entender el CLI scrap-ingest y la API HTTP. Triggers scrapito, ofertas, offers, buscar ofertas, actualizar catálogo, scrape, ingest, scrap-ingest, precios, Ripley, Falabella, catalog reader, GET /offers.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Scrapito — catálogo de ofertas (Perú)

Monorepo **Bun + TypeScript** que scrapea y sirve ofertas de **Ripley PE** y
**Falabella PE**. Todos los precios están en **centavos** y moneda **PEN**.

## Regla de oro (leer antes de tocar nada)

1. **Un solo escritor.** Solo `scrap-ingest run` / `scrap-ingest discover`
   escriben en la BD, y toman un *writer lease* (`writer_leases`, TTL 60s). Si
   otro proceso lo tiene, fallas rápido con `WRITER_LOCKED`. Nunca abras dos
   `run` a la vez.
2. **La API y la web son de solo lectura.** `apps/api` abre solo
   `@scrapito/catalog/read`; físicamente no puede mutar. No existen rutas de
   escritura.
3. **Fronteras de import (enforzadas por test).** `apps/api`/`apps/web` nunca
   importan `@scrapito/catalog/write` ni `apps/ingest/*`. `@scrapito/contracts`
   es neutral (nada de `bun:sqlite`, fs, browser, Hono). `scrapers/**` y
   `discovery/**` no se importan mutuamente. Ver `tests/integration/security.test.ts`.
4. **Bun, no Node.** Corre todo con `bun` desde la raíz del repo.

## IDs válidos

- **Scrapers:** `ripley-pe`, `falabella-pe` (`fixture-products` es solo para
  el test de integración — hace fetch real, no lo uses como semilla offline).
- **Stores:** `ripley-pe`, `falabella-pe`.

---

## Setup (primera vez)

```bash
bun install
bun run db:migrate            # crea/actualiza data/scrap.sqlite (write-side)
```

Para scrapear necesitas además el browser y un user-agent honesto:

```bash
bun run browser:install       # instala agent-browser
bun run browser:doctor        # verifica que el browser funciona
export SCRAP_USER_AGENT="miorg-scraper/1.0 (contacto@miorg.com)"
```

### Variables de entorno

| Var | Usada por | Default | Nota |
|---|---|---|---|
| `SCRAP_DB_PATH` | ingest + api | `./data/scrap.sqlite` | archivo SQLite compartido |
| `SCRAP_STORAGE_DIR` | ingest + api | `./storage` | bytes de imágenes |
| `SCRAP_USER_AGENT` | ingest (`run`) | — | **obligatorio** para `run` |
| `SCRAP_DISCOVERY_DIR` | ingest | `./data/discovery` | artefactos de discovery |
| `AGENT_BROWSER_BIN` | ingest | `node_modules/.bin/agent-browser` | |
| `AGENT_BROWSER_DEFAULT_TIMEOUT` | ingest | `25000` | ms |
| `SCRAP_HOST` | api | `127.0.0.1` | |
| `SCRAP_PORT` | api | `3000` | |
| `SCRAP_PUBLIC_READS` | api | `false` | `true` para bindear host no-loopback |
| `WEB_ORIGIN` | api | — | orígenes CORS exactos, coma-separados |
| `SCRAP_API_BASE_URL` | `offers query` | `http://127.0.0.1:3000` | |

---

## Tarea: BUSCAR OFERTAS

Hay tres vías; elige según el contexto.

### A) Vía CLI (requiere la API levantada)

`scrap-ingest offers query` valida los filtros localmente y luego hace `GET
/offers` a la API. Primero levanta la API en otra terminal:

```bash
bun run dev:api               # sirve en http://127.0.0.1:3000
```

```bash
# ofertas con descuento verificado, ordenadas por descuento
bun run ingest -- offers query --quality verified_discount --sort discount_desc --limit 10 --json

# búsqueda por texto (sort relevance requiere --query)
bun run ingest -- offers query --query "laptop" --sort relevance --json

# filtros combinados (flags repetibles)
bun run ingest -- offers query --store ripley-pe --brand Samsung --brand LG \
  --price-access card --max-effective-cents 150000 --min-discount-bps 2000 --json
```

### B) Vía HTTP directo a la API

```bash
curl 'http://127.0.0.1:3000/offers?quality=verified_discount&sort=discount_desc&limit=10'
curl 'http://127.0.0.1:3000/offers?store=ripley-pe&store=falabella-pe&priceAccess=card'
curl 'http://127.0.0.1:3000/offers?q=laptop&sort=relevance'          # relevance exige q
curl 'http://127.0.0.1:3000/offers/123/history'                      # histórico de precios
```

### C) Vía script (sin API, lectura directa del catálogo) — recomendado para agentes

No necesitas levantar servidor. Usa los mismos contratos que la API para tener
semántica idéntica. Ver "Escribir scripts" abajo.

### Filtros de `GET /offers` (query params)

| Param | Valores | Nota |
|---|---|---|
| `q` | texto (≤200 code points) | frase FTS5 escapada |
| `store` | `ripley-pe` \| `falabella-pe` | repetible (máx 20) |
| `categoryId` | entero positivo | repetible |
| `brand` | texto (≤100) | repetible |
| `quality` | `verified_discount` \| `promotional_price` | repetible |
| `priceAccess` | `public` \| `card` | repetible |
| `inStock` | `true` \| `false` | default `true` |
| `minEffectiveCents` / `maxEffectiveCents` | entero (centavos) | min ≤ max |
| `minDiscountBps` | 0–10000 | 2000 = 20% |
| `sort` | `relevance` \| `discount_desc` \| `price_asc` \| `price_desc` \| `updated_desc` | `relevance` requiere `q`; default `discount_desc` (o `relevance` si hay `q`) |
| `cursor` | opaco | paginación keyset |
| `limit` | 1–100 | default 24 |

Respuesta: `{ data: OfferSummary[], nextCursor: string|null, facets: {...} }`.
Cada `OfferSummary` trae `effectiveCents`, `regularCents`, `offerCents`,
`cardCents`, `priceAccess`, `quality`, `discountCents`, `discountBps`,
`canonicalUrl`, `imageUrl`, `inStock`, etc. (todos en centavos PEN).

---

## Tarea: ACTUALIZAR CATÁLOGO (scrapear)

`scrap-ingest run <scraperId>` es **la única forma de escribir productos**. Es
síncrono, toma el lease, corre el scraper, descarga imágenes y commitea en una
transacción. Necesita `SCRAP_USER_AGENT`.

```bash
# actualizar Ripley por categoría, 3 páginas, salida JSON de una línea
bun run ingest -- run ripley-pe --category tecnologia --pages 1-3 --json

# búsqueda por keyword
bun run ingest -- run falabella-pe --search juguetes --json

# acotar presupuesto (siempre se clampa hacia ABAJO contra el techo del scraper)
bun run ingest -- run ripley-pe --max-requests 40 --max-duration 60000 --json

# sin descargar imágenes (más rápido)
bun run ingest -- run ripley-pe --category tecnologia --no-images --json
```

**Opciones de `run`:** `--category <v>`, `--search <term>`, `--pages <n|a-b>`,
`--max-requests <n>`, `--max-duration <ms>`, `--no-images`, `--json`.

**Resultado JSON** (`--json` emite exactamente una línea en stdout; logs van a
stderr):

```json
{"runId":"...","scraperId":"ripley-pe","storeId":"ripley-pe","status":"completed",
 "startedAt":"...","finishedAt":"...","productsSaved":42,"productsRejected":0,
 "imagesDownloaded":40,"requestsMade":12,"error":null}
```

`status` ∈ `completed | partial | failed`. Exit code 1 si `failed`.

### Antes de correr un scraper nuevo o dudoso

```bash
bun run ingest -- scrapers list                 # scrapers registrados
bun run ingest -- scrapers validate ripley-pe   # validación offline (sin red ni browser)
bun run ingest -- stores list                   # stores configurados
```

---

## Tarea: ESCRIBIR SCRIPTS

Cualquier `.ts` en el repo resuelve los paquetes del workspace por symlink.
Corre con `bun run ruta/al/script.ts` desde la raíz.

### Import map

| Necesitas | Import |
|---|---|
| Schemas/tipos/errores/codecs puros | `@scrapito/contracts` |
| Leer catálogo (solo lectura) | `@scrapito/catalog/read` |
| Escribir catálogo (avanzado, single-writer) | `@scrapito/catalog/write` |

`@scrapito/contracts` exporta, entre otros: `deriveOffer`,
`decodeOfferSearchParams`, `encodeOfferSearchParams`, `OfferSearchInputSchema`,
`OfferSummarySchema`, `StoreIdSchema`, `ScrapError`, `decodeCursor`,
`toFtsMatchQuery`.

`@scrapito/catalog/read` exporta `openCatalogReader(path) → { db, queries, close }`.
Métodos de `queries` (`CatalogQueries`):
`listStores()`, `listProducts({store?,afterId?,limit?})`, `getProduct(id)`,
`getPrices(productId)`, `getImages(productId)`, `search(q,{limit?})`, `stats()`,
`getImageMeta(sha256)`, `listUpdates({store?,beforeId?,limit?})`,
`getFreshness()`, `searchOffers(input)`, `getOfferHistory(productId)`.

### Ejemplo: buscar ofertas en un script (sin API)

```ts
// scripts/find-offers.ts  →  bun run scripts/find-offers.ts
import { openCatalogReader } from "@scrapito/catalog/read";
import { decodeOfferSearchParams } from "@scrapito/contracts";

const reader = openCatalogReader(process.env.SCRAP_DB_PATH ?? "data/scrap.sqlite");
try {
  const input = decodeOfferSearchParams(
    new URLSearchParams({ quality: "verified_discount", sort: "discount_desc", limit: "10" }),
  );
  const page = reader.queries.searchOffers(input);
  for (const o of page.data) {
    console.log(`${o.storeId}  ${o.name}  S/ ${(o.effectiveCents / 100).toFixed(2)}  (-${o.discountBps ?? 0}bps)`);
  }
  console.log("nextCursor:", page.nextCursor);
} finally {
  reader.close();
}
```

### Ejemplo: frescura y stats del catálogo

```ts
import { openCatalogReader } from "@scrapito/catalog/read";
const reader = openCatalogReader(process.env.SCRAP_DB_PATH ?? "data/scrap.sqlite");
console.log(reader.queries.getFreshness());  // por store: última corrida, edad, etc.
console.log(reader.queries.stats());         // conteos de products/prices/images
reader.close();
```

> `openCatalogReader` es estrictamente readonly y **exige** que la BD ya esté
> migrada (lanza `CatalogMigrationsPendingError`/`CatalogDatabaseNotFoundError`
> si no existe/está desactualizada). Corre `bun run db:migrate` primero.

### Escritura desde un script (avanzado)

Solo si de verdad necesitas sembrar/mutar sin el CLI: importa
`@scrapito/catalog/write` (`openCatalogWriter`), **adquiere `WriterLease` antes
de cualquier escritura** y libéralo en `finally`. Respeta el single-writer o
chocarás con un `run` en curso (`WRITER_LOCKED`). En la práctica, prefiere
`scrap-ingest run`.

---

## Referencia: endpoints de la API (todos GET)

| Ruta | Devuelve |
|---|---|
| `/health` | `{status:"ok"}` |
| `/stores` | stores configurados |
| `/categories?store=` | categorías (placeholder) |
| `/products?store=&cursor=&limit=` | página de productos (keyset) |
| `/products/:id` | detalle + variantes activas |
| `/products/:id/prices` | observaciones de precio |
| `/offers?...` | búsqueda de ofertas (ver filtros arriba) |
| `/offers/:productId/history` | histórico de oferta/precio |
| `/updates?store=&cursor=&limit=` | corridas recientes |
| `/freshness` | edad de datos por store |
| `/images/:sha256` | bytes de imagen (256 hex) |

Errores: `{ error: { code, message, details? } }`. Códigos: `BAD_REQUEST`,
`INVALID_CURSOR`, `NOT_FOUND`, `INTERNAL`.

## Referencia: comandos del CLI `scrap-ingest`

Invócalo como `bun run ingest -- <args>` (o `bun run --filter @scrapito/ingest scrap-ingest <args>`).

| Comando | Escribe? | Qué hace |
|---|---|---|
| `db migrate` | sí | aplica migraciones (idempotente) |
| `db reset --yes` | sí | DROP y recrea la BD (destructivo) |
| `browser install` / `browser doctor` | no | gestiona agent-browser |
| `stores list` | no | lista stores |
| `scrapers list` | no | lista scrapers registrados |
| `scrapers validate <fileOrId>` | no | validación estática + fixtures (offline) |
| `discover list` / `discover run <id>` | discover=sí | reconocimiento local (nunca auto-registra) |
| `run <scraperId> [opts]` | **sí** | ingesta síncrona (la única que guarda productos) |
| `offers query [opts]` | no | búsqueda de ofertas vía `GET /offers` |

## Códigos de error típicos (CLI/dominio)

`WRITER_LOCKED` (otro writer activo), `POLICY_DENIED` (falta `SCRAP_USER_AGENT`
o dominio no permitido), `DB_NOT_READY` (BD sin migrar), `UNKNOWN_SCRAPER`,
`CIRCUIT_OPEN` (circuit breaker), `BUDGET_EXHAUSTED` (tope de requests/tiempo),
`CHALLENGE_DETECTED` (anti-bot), `BAD_REQUEST`.

## Qué NO hacer

- No corras dos `run`/`discover` en paralelo (single-writer).
- No importes `@scrapito/catalog/write` desde `apps/api` o `apps/web`.
- No metas `bun:sqlite`/fs/Hono/browser en `@scrapito/contracts`.
- No edites `packages/catalog/src/migrations/0001_init.sql` (histórica); agrega
  una migración nueva `000N_*.sql`.
- No pongas un user-agent falso; `SCRAP_USER_AGENT` debe ser honesto.
- No cambies precios a "soles": todo es **centavos** internamente.

## Verificación rápida

```bash
bun run typecheck      # los 5 paquetes
bun run test           # unit + tests/integration
```

Más contexto de arquitectura: `AGENTS.md` y `README.md` en la raíz del repo.
