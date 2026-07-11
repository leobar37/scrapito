#!/usr/bin/env bun
/**
 * Reporte de las mejores ofertas de tecnología para computadoras.
 *
 * SOLO LECTURA: abre `@scrapito/catalog/read` (no scrapea, no escribe). Pensado
 * para correr periódicamente (cron / systemd timer) y dejar un reporte
 * reproducible en disco. La ingesta (actualizar datos) es un paso aparte
 * (`scrap-ingest run`), respetando el diseño single-writer.
 *
 * Uso:
 *   bun run scripts/reports/tech-deals.ts [flags]
 *
 * Flags (todas opcionales):
 *   --keywords laptop,notebook,...    términos a buscar (OR entre términos)
 *   --stores ripley-pe,falabella-pe   filtrar tiendas
 *   --min-discount-bps 1500           descuento mínimo (1500 = 15.0%)
 *   --price-access public,card        accesos de precio
 *   --max-effective-cents 500000      techo de precio efectivo (centavos)
 *   --top 30                          cuántas ofertas en el reporte
 *   --per-keyword 100                 tope por término (1..100)
 *   --max-pages 3                     páginas keyset por término
 *   --out reports/tech-deals          carpeta de salida
 *   --db data/scrap.sqlite            ruta de la BD (o SCRAP_DB_PATH)
 *   --include-out-of-stock            incluir agotados
 */
import { parseArgs } from "node:util";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  openCatalogReader,
  CatalogDatabaseNotFoundError,
  CatalogMigrationsPendingError,
  type CatalogReader,
} from "@scrapito/catalog/read";
import {
  decodeOfferSearchParams,
  ScrapError,
  type OfferSummary,
  type StoreId,
} from "@scrapito/contracts";

/** Términos por defecto para "tecnología de computadoras". */
const DEFAULT_KEYWORDS: readonly string[] = [
  "laptop",
  "notebook",
  "computadora",
  "monitor",
  "procesador",
  "ssd",
  "memoria ram",
  "tarjeta grafica",
];

/** Configuración resuelta del reporte (contrato con nombre, sin ReturnType). */
interface ReportOptions {
  keywords: readonly string[];
  stores: readonly StoreId[] | undefined;
  priceAccess: readonly string[] | undefined;
  minDiscountBps: number;
  maxEffectiveCents: number | undefined;
  top: number;
  perKeyword: number;
  maxPages: number;
  includeOutOfStock: boolean;
  dbPath: string;
  outDir: string;
}

/** Resumen agregado que acompaña al reporte. */
interface ReportSummary {
  generatedAt: string;
  scanned: number;
  reported: number;
  byStore: Record<string, number>;
  topBrands: Array<{ brand: string; count: number }>;
  bestBps: number | null;
}

function toList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function toInt(value: string | undefined, fallback: number): number {
  const n = value == null ? Number.NaN : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseOptions(): ReportOptions {
  const { values } = parseArgs({
    options: {
      keywords: { type: "string" },
      stores: { type: "string" },
      "min-discount-bps": { type: "string" },
      "price-access": { type: "string" },
      "max-effective-cents": { type: "string" },
      top: { type: "string" },
      "per-keyword": { type: "string" },
      "max-pages": { type: "string" },
      out: { type: "string" },
      db: { type: "string" },
      "include-out-of-stock": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const maxEff = values["max-effective-cents"];
  return {
    keywords: toList(values.keywords) ?? DEFAULT_KEYWORDS,
    stores: toList(values.stores) as StoreId[] | undefined,
    priceAccess: toList(values["price-access"]),
    minDiscountBps: toInt(values["min-discount-bps"], 1000),
    maxEffectiveCents: maxEff != null ? toInt(maxEff, 0) : undefined,
    top: toInt(values.top, 30),
    perKeyword: Math.min(Math.max(toInt(values["per-keyword"], 100), 1), 100),
    maxPages: Math.max(toInt(values["max-pages"], 3), 1),
    includeOutOfStock: Boolean(values["include-out-of-stock"]),
    dbPath: values.db ?? process.env.SCRAP_DB_PATH ?? "data/scrap.sqlite",
    outDir: values.out ?? "reports/tech-deals",
  };
}

const soles = (cents: number): string => `S/ ${(cents / 100).toFixed(2)}`;
const percent = (bps: number | null): string => (bps == null ? "—" : `${(bps / 100).toFixed(1)}%`);

function buildParams(opts: ReportOptions, keyword: string, cursor: string | undefined): URLSearchParams {
  const params = new URLSearchParams();
  params.set("q", keyword);
  params.set("quality", "verified_discount");
  params.set("sort", "discount_desc"); // válido junto con q (solo "relevance" exige q)
  params.set("limit", String(opts.perKeyword));
  params.set("inStock", opts.includeOutOfStock ? "false" : "true");
  if (opts.minDiscountBps > 0) params.set("minDiscountBps", String(opts.minDiscountBps));
  if (opts.maxEffectiveCents != null) params.set("maxEffectiveCents", String(opts.maxEffectiveCents));
  for (const store of opts.stores ?? []) params.append("store", store);
  for (const access of opts.priceAccess ?? []) params.append("priceAccess", access);
  if (cursor) params.set("cursor", cursor);
  return params;
}

/** Busca por cada término, pagina y deduplica por id de oferta (colección
 * dinámica en runtime → Map, no Record). Devuelve el top ordenado. */
function gatherOffers(reader: CatalogReader, opts: ReportOptions): OfferSummary[] {
  const unique = new Map<number, OfferSummary>();

  for (const keyword of opts.keywords) {
    let cursor: string | undefined;
    for (let page = 0; page < opts.maxPages; page++) {
      const input = decodeOfferSearchParams(buildParams(opts, keyword, cursor));
      const result = reader.queries.searchOffers(input);
      for (const offer of result.data) {
        const existing = unique.get(offer.id);
        if (!existing || (offer.discountBps ?? -1) > (existing.discountBps ?? -1)) {
          unique.set(offer.id, offer);
        }
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }

  return [...unique.values()].sort((a, b) => {
    const byDiscount = (b.discountBps ?? -1) - (a.discountBps ?? -1);
    return byDiscount !== 0 ? byDiscount : a.effectiveCents - b.effectiveCents;
  });
}

function summarize(scanned: number, reported: OfferSummary[], generatedAt: string): ReportSummary {
  const byStore: Record<string, number> = {};
  const brandCounts = new Map<string, number>();
  for (const offer of reported) {
    byStore[offer.storeId] = (byStore[offer.storeId] ?? 0) + 1;
    if (offer.brand) brandCounts.set(offer.brand, (brandCounts.get(offer.brand) ?? 0) + 1);
  }
  const topBrands = [...brandCounts.entries()]
    .map(([brand, count]) => ({ brand, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return {
    generatedAt,
    scanned,
    reported: reported.length,
    byStore,
    topBrands,
    bestBps: reported[0]?.discountBps ?? null,
  };
}

function renderMarkdown(offers: OfferSummary[], opts: ReportOptions, summary: ReportSummary): string {
  const lines: string[] = [];
  lines.push("# Mejores ofertas de tecnología (computadoras)");
  lines.push("");
  lines.push(`Generado: ${summary.generatedAt}`);
  lines.push(`Términos: ${opts.keywords.join(", ")}`);
  lines.push(
    `Filtros: descuento verificado ≥ ${percent(opts.minDiscountBps)}` +
      (opts.stores ? ` · tiendas: ${opts.stores.join(", ")}` : " · todas las tiendas") +
      (opts.includeOutOfStock ? " · incluye agotados" : " · solo en stock"),
  );
  lines.push("");
  lines.push(
    `Escaneadas ${summary.scanned} ofertas únicas · reportando top ${summary.reported}` +
      (summary.bestBps != null ? ` · mejor descuento ${percent(summary.bestBps)}` : ""),
  );
  const byStore = Object.entries(summary.byStore)
    .map(([store, count]) => `${store}: ${count}`)
    .join(" · ");
  if (byStore) lines.push(`Por tienda: ${byStore}`);
  if (summary.topBrands.length) {
    lines.push(`Marcas top: ${summary.topBrands.map((b) => `${b.brand} (${b.count})`).join(", ")}`);
  }
  lines.push("");

  if (offers.length === 0) {
    lines.push("> Sin ofertas que cumplan los filtros. ¿Ya corriste la ingesta?");
    lines.push("> `bun run ingest -- run ripley-pe --category tecnologia --json`");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| # | Producto | Tienda | Marca | Efectivo | Regular | Desc. | Acceso | Stock | Link |");
  lines.push("|--:|----------|--------|-------|---------:|--------:|------:|--------|:-----:|------|");
  offers.forEach((o, i) => {
    const name = o.name.replace(/\|/g, "\\|").slice(0, 70);
    const brand = (o.brand ?? "—").replace(/\|/g, "\\|");
    const regular = o.regularCents != null ? soles(o.regularCents) : "—";
    const access = o.priceAccess === "card" ? "tarjeta" : "público";
    lines.push(
      `| ${i + 1} | ${name} | ${o.storeId} | ${brand} | ${soles(o.effectiveCents)} | ${regular} | ` +
        `${percent(o.discountBps)} | ${access} | ${o.inStock ? "sí" : "no"} | [ver](${o.canonicalUrl}) |`,
    );
  });
  lines.push("");
  return lines.join("\n");
}

function toCsv(offers: OfferSummary[]): string {
  const header = [
    "rank",
    "id",
    "store",
    "brand",
    "name",
    "effectiveCents",
    "regularCents",
    "priceAccess",
    "discountBps",
    "inStock",
    "canonicalUrl",
  ];
  const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const rows = offers.map((o, i) =>
    [
      String(i + 1),
      String(o.id),
      o.storeId,
      escape(o.brand ?? ""),
      escape(o.name),
      String(o.effectiveCents),
      o.regularCents != null ? String(o.regularCents) : "",
      o.priceAccess,
      o.discountBps != null ? String(o.discountBps) : "",
      o.inStock ? "true" : "false",
      escape(o.canonicalUrl),
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

async function main(): Promise<void> {
  const opts = parseOptions();

  let reader: CatalogReader;
  try {
    reader = openCatalogReader(opts.dbPath);
  } catch (err) {
    if (err instanceof CatalogDatabaseNotFoundError) {
      console.error(`No existe la BD en ${opts.dbPath}. Corre: bun run db:migrate`);
      process.exit(2);
    }
    if (err instanceof CatalogMigrationsPendingError) {
      console.error("La BD tiene migraciones pendientes. Corre: bun run db:migrate");
      process.exit(2);
    }
    throw err;
  }

  try {
    const all = gatherOffers(reader, opts);
    const generatedAt = new Date().toISOString();
    const top = all.slice(0, opts.top);
    const summary = summarize(all.length, top, generatedAt);

    const stamp = generatedAt.replace(/[:.]/g, "-");
    const dir = join(opts.outDir, stamp);
    mkdirSync(dir, { recursive: true });

    const markdown = renderMarkdown(top, opts, summary);
    await Bun.write(join(dir, "report.md"), markdown);
    await Bun.write(join(dir, "offers.csv"), toCsv(top));
    await Bun.write(join(dir, "offers.json"), JSON.stringify({ summary, offers: top }, null, 2));
    await Bun.write(join(opts.outDir, "latest.md"), markdown);

    console.log(
      `[tech-deals] ${summary.reported}/${summary.scanned} ofertas · ` +
        (summary.bestBps != null ? `mejor ${percent(summary.bestBps)} · ` : "") +
        `reporte: ${join(dir, "report.md")}`,
    );
    for (const offer of top.slice(0, 5)) {
      console.log(`  ${percent(offer.discountBps).padStart(6)}  ${soles(offer.effectiveCents).padStart(12)}  ${offer.storeId}  ${offer.name.slice(0, 60)}`);
    }
  } catch (err) {
    if (err instanceof ScrapError) {
      console.error(`[tech-deals] parámetros inválidos: ${err.code} ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    reader.close();
  }
}

await main();
