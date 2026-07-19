/**
 * CatalogQueries — read-side queries backing the HTTP API, CLI, and web app.
 * Returns typed DTOs (never raw HTML). `searchOffers` is the set-based offer
 * search/pagination/facet engine over the `current_offers` view.
 */
import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import {
  encodeCursor,
  toFtsMatchQuery,
  deriveOffer,
  CoverageOfferHandoffQuerySchema,
  CoverageOfferHandoffSchema,
  CurrentPriceDropSchema,
  PriceMovementSchema,
  ProductSightingSchema,
  TargetCoverageSchema,
  TargetIdentityInputSchema,
  TargetIdentitySchema,
  TargetMembershipSchema,
  type OfferFacets,
  type OfferHistory,
  type OfferSearchInput,
  type OfferSearchPage,
  type OfferSummary,
  type CurrentPriceDrop,
  type PriceMovement,
  type ProductSighting,
  type TargetCoverage,
  type TargetIdentity,
  type TargetMembership,
  type CoverageOfferHandoff,
  type Page,
  type PriceObservation,
  type ProductDetail,
  type ProductImageRef,
  type ProductSummary,
  type ProductVariant,
  type StoreFreshness,
  type StoreId,
  type UpdateRunSummary,
  ScrapError,
} from "@scrapito/contracts";
import type {
  CurrentOfferRow,
  CurrentPriceDropRow,
  ImageSourceRow,
  PriceMovementRow,
  PriceRow,
  ProductRow,
  ProductSightingRow,
  RunRow,
  TargetCoverageRow,
  TargetIdentityRow,
  TargetMembershipRow,
  VariantImageRow,
  VariantRow,
} from "../rows.ts";
import { decodeOfferCursor, encodeOfferCursor, type OfferCursorKey } from "./offer-cursor.ts";
import { decodeCoverageOfferCursor, encodeCoverageOfferCursor } from "./coverage-offer-cursor.ts";

const MAX_LIMIT = 100;

interface StoreRow {
  id: StoreId;
  name: string;
  base_url: string;
}

interface CoverageHandoffMetaRow extends TargetCoverageRow {
  invocation_id: string | null;
  store_id: StoreId;
}

interface CoverageHandoffOfferRow extends PriceMovementRow {
  sighting_id: number;
  coverage_id: number;
  seen_at: string;
  sighting_source_hash: string | null;
  store_id: StoreId;
  external_id: string;
  name_snapshot: string | null;
  brand_snapshot: string | null;
  canonical_url_snapshot: string | null;
  seller_id_snapshot: string | null;
  seller_name_snapshot: string | null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return 20;
  return Math.min(limit, MAX_LIMIT);
}

function parseAttributes(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseNullableJson(json: string | null): unknown | null {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export class CatalogQueries {
  constructor(private readonly db: Database) {}

  listStores(): StoreRow[] {
    return this.db.query<StoreRow, SQLQueryBindings[]>("SELECT id, name, base_url FROM stores ORDER BY id").all();
  }

  private latestPrice(productId: number): PriceRow | null {
    return this.db
      .query<PriceRow, SQLQueryBindings[]>(
        "SELECT * FROM price_observations WHERE product_id=? ORDER BY observed_at DESC, id DESC LIMIT 1",
      )
      .get(productId);
  }

  private firstImageSha(productId: number): string | null {
    const row = this.db
      .query<{ sha256: string }, SQLQueryBindings[]>(
        "SELECT sha256 FROM product_images WHERE product_id=? ORDER BY position LIMIT 1",
      )
      .get(productId);
    return row?.sha256 ?? null;
  }

  private toSummary(p: ProductRow): ProductSummary {
    const price = this.latestPrice(p.id);
    const sha = this.firstImageSha(p.id);
    return {
      id: p.id,
      storeId: p.store_id,
      externalId: p.external_id,
      name: p.name,
      brand: p.brand,
      sellerName: p.seller_name,
      canonicalUrl: p.canonical_url,
      regularCents: price?.regular_cents ?? null,
      offerCents: price?.offer_cents ?? null,
      cardCents: price?.card_cents ?? null,
      currency: "PEN",
      inStock: price ? price.in_stock === 1 : false,
      imageUrl: sha ? `/images/${sha}` : null,
      lastSeenAt: p.last_seen_at,
    };
  }

  listProducts(options: { store?: StoreId; afterId?: number; limit?: number }): Page<ProductSummary> {
    const limit = clampLimit(options.limit);
    const after = options.afterId ?? 0;
    const rows = options.store
      ? this.db
          .query<ProductRow, SQLQueryBindings[]>(
            "SELECT * FROM products WHERE id > ? AND store_id = ? ORDER BY id LIMIT ?",
          )
          .all(after, options.store, limit + 1)
      : this.db
          .query<ProductRow, SQLQueryBindings[]>("SELECT * FROM products WHERE id > ? ORDER BY id LIMIT ?")
          .all(after, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { data: page.map((p) => this.toSummary(p)), nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  private getVariants(productId: number): ProductVariant[] {
    const rows = this.db
      .query<VariantRow, SQLQueryBindings[]>(
        "SELECT * FROM product_variants WHERE product_id=? AND active=1 ORDER BY id",
      )
      .all(productId);
    return rows.map((v) => {
      const images = this.db
        .query<VariantImageRow & { mime: string }, SQLQueryBindings[]>(
          `SELECT vi.variant_id AS variant_id, vi.sha256 AS sha256, vi.position AS position, i.mime AS mime
             FROM variant_images vi JOIN images i ON i.sha256 = vi.sha256
            WHERE vi.variant_id=? ORDER BY vi.position`,
        )
        .all(v.id);
      return {
        id: v.id,
        externalId: v.external_id,
        sku: v.sku,
        name: v.name,
        colorName: v.color_name,
        colorHex: v.color_hex,
        size: v.size,
        inStock: v.in_stock === 1,
        attributes: parseAttributes(v.attributes_json),
        images: images.map((img) => ({
          sha256: img.sha256,
          position: img.position,
          mime: img.mime,
          url: `/images/${img.sha256}`,
        })),
      };
    });
  }

  getProduct(id: number): ProductDetail | null {
    const p = this.db.query<ProductRow, SQLQueryBindings[]>("SELECT * FROM products WHERE id=?").get(id);
    if (!p) return null;
    const summary = this.toSummary(p);
    const prices = this.getPrices(id);
    const images = this.getImages(id);
    const variants = this.getVariants(id);
    return { ...summary, description: p.description ?? null, attributes: parseAttributes(p.attributes_json), prices, images, variants };
  }

  getPrices(productId: number): PriceObservation[] {
    const rows = this.db
      .query<PriceRow, SQLQueryBindings[]>(
        "SELECT * FROM price_observations WHERE product_id=? ORDER BY observed_at DESC, id DESC",
      )
      .all(productId);
    return rows.map((r) => ({
      observedAt: r.observed_at,
      regularCents: r.regular_cents,
      offerCents: r.offer_cents,
      cardCents: r.card_cents,
      currency: "PEN",
      sellerId: r.seller_id,
      inStock: r.in_stock === 1,
    }));
  }

  getImages(productId: number): ProductImageRef[] {
    const rows = this.db
      .query<{ sha256: string; position: number; mime: string }, SQLQueryBindings[]>(
        `SELECT pi.sha256 AS sha256, pi.position AS position, i.mime AS mime
           FROM product_images pi JOIN images i ON i.sha256 = pi.sha256
          WHERE pi.product_id=? ORDER BY pi.position`,
      )
      .all(productId);
    return rows.map((r) => ({ sha256: r.sha256, position: r.position, mime: r.mime, url: `/images/${r.sha256}` }));
  }

  search(query: string, options: { limit?: number } = {}): ProductSummary[] {
    const limit = clampLimit(options.limit);
    const rows = this.db
      .query<ProductRow, SQLQueryBindings[]>(
        `SELECT p.* FROM products p
           JOIN products_fts f ON f.rowid = p.id
          WHERE products_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(toFtsMatchQuery(query), limit);
    return rows.map((p) => this.toSummary(p));
  }

  stats(): Record<string, number> {
    const products = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM products").get()?.c ?? 0;
    const prices = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM price_observations").get()?.c ?? 0;
    const images = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM images").get()?.c ?? 0;
    const runs = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM scraper_runs").get()?.c ?? 0;
    return { products, prices, images, runs };
  }

  getImageMeta(sha256: string): { relativePath: string; mime: string } | null {
    const r = this.db
      .query<{ relative_path: string; mime: string }, SQLQueryBindings[]>(
        "SELECT relative_path, mime FROM images WHERE sha256=?",
      )
      .get(sha256);
    return r ? { relativePath: r.relative_path, mime: r.mime } : null;
  }

  // ---- Updates / freshness (read-only observability, no queue) ----

  private toUpdateSummary(r: RunRow): UpdateRunSummary {
    return {
      runId: r.id,
      scraperId: r.scraper_id,
      storeId: r.store_id,
      status: r.status as UpdateRunSummary["status"],
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      productsSaved: r.products_saved,
      productsRejected: r.products_rejected,
      imagesDownloaded: r.images_downloaded,
      requestsMade: r.requests_made,
      error: r.last_error,
    };
  }

  listUpdates(options: { store?: StoreId; beforeId?: number; limit?: number }): Page<UpdateRunSummary> {
    const limit = clampLimit(options.limit);
    const before = options.beforeId ?? Number.MAX_SAFE_INTEGER;
    const rows = options.store
      ? this.db
          .query<RunRow, SQLQueryBindings[]>(
            "SELECT * FROM scraper_runs WHERE id < ? AND store_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(before, options.store, limit + 1)
      : this.db
          .query<RunRow, SQLQueryBindings[]>("SELECT * FROM scraper_runs WHERE id < ? ORDER BY id DESC LIMIT ?")
          .all(before, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { data: page.map((r) => this.toUpdateSummary(r)), nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  getFreshness(): StoreFreshness[] {
    const stores = this.listStores();
    const now = Date.now();
    return stores.map((s) => {
      const lastSuccessful = this.db
        .query<RunRow, SQLQueryBindings[]>(
          "SELECT * FROM scraper_runs WHERE store_id=? AND status IN ('completed','partial') ORDER BY finished_at DESC, id DESC LIMIT 1",
        )
        .get(s.id);
      const latestRun = this.db
        .query<RunRow, SQLQueryBindings[]>(
          "SELECT * FROM scraper_runs WHERE store_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(s.id);
      const lastSuccessfulAt = lastSuccessful?.finished_at ?? null;
      return {
        storeId: s.id,
        lastSuccessfulAt,
        ageSeconds: lastSuccessfulAt ? Math.max(0, Math.floor((now - Date.parse(lastSuccessfulAt)) / 1000)) : null,
        latestRun: latestRun ? this.toUpdateSummary(latestRun) : null,
      };
    });
  }

  // ---- Offer search ----

  private toOfferSummary(r: CurrentOfferRow): OfferSummary {
    const sha = this.firstImageSha(r.product_id);
    return {
      id: r.product_id,
      storeId: r.store_id,
      externalId: r.external_id,
      name: r.name,
      brand: r.brand,
      sellerName: r.seller_name,
      canonicalUrl: r.canonical_url,
      imageUrl: sha ? `/images/${sha}` : null,
      currency: "PEN",
      regularCents: r.regular_cents,
      offerCents: r.offer_cents,
      cardCents: r.card_cents,
      effectiveCents: r.effective_cents,
      priceAccess: r.price_access,
      quality: r.quality,
      discountCents: r.discount_cents,
      discountBps: r.discount_bps,
      inStock: r.in_stock === 1,
      latestPriceObservedAt: r.latest_price_observed_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  /** Build WHERE fragments + params for every dimension EXCEPT `exclude`. Used
   * both for the page query (exclude=undefined) and per-facet counts (exclude
   * = that facet's own dimension), so each facet only drops its own filter. */
  private buildOfferFilters(
    input: OfferSearchInput,
    exclude?: "stores" | "brands" | "categoryIds" | "quality" | "priceAccess",
  ): { joins: string; where: string[]; params: SQLQueryBindings[] } {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    let joins = "";

    if (input.q) {
      joins += " JOIN products_fts f ON f.rowid = co.product_id";
      where.push("products_fts MATCH ?");
      params.push(toFtsMatchQuery(input.q));
    }
    if (exclude !== "stores" && input.stores?.length) {
      where.push(`co.store_id IN (${input.stores.map(() => "?").join(",")})`);
      params.push(...input.stores);
    }
    if (exclude !== "brands" && input.brands?.length) {
      where.push(`co.brand IN (${input.brands.map(() => "?").join(",")})`);
      params.push(...input.brands);
    }
    if (exclude !== "quality" && input.quality?.length) {
      where.push(`co.quality IN (${input.quality.map(() => "?").join(",")})`);
      params.push(...input.quality);
    }
    if (exclude !== "priceAccess" && input.priceAccess?.length) {
      where.push(`co.price_access IN (${input.priceAccess.map(() => "?").join(",")})`);
      params.push(...input.priceAccess);
    }
    if (input.inStock) where.push("co.in_stock = 1");
    if (input.seenAfter) {
      where.push("co.last_seen_at >= ?");
      params.push(input.seenAfter);
    }
    if (input.minEffectiveCents != null) {
      where.push("co.effective_cents >= ?");
      params.push(input.minEffectiveCents);
    }
    if (input.maxEffectiveCents != null) {
      where.push("co.effective_cents <= ?");
      params.push(input.maxEffectiveCents);
    }
    if (input.minDiscountBps != null) {
      where.push("COALESCE(co.discount_bps, -1) >= ?");
      params.push(input.minDiscountBps);
    }
    if (exclude !== "categoryIds" && input.categoryIds?.length) {
      where.push(
        `co.product_id IN (SELECT product_id FROM product_categories WHERE category_id IN (${input.categoryIds
          .map(() => "?")
          .join(",")}))`,
      );
      params.push(...input.categoryIds);
    }
    return { joins, where, params };
  }

  private computeOfferFacets(input: OfferSearchInput): OfferFacets {
    const dims: Array<{
      key: "stores" | "brands" | "categoryIds" | "quality" | "priceAccess";
      column: string;
    }> = [
      { key: "stores", column: "co.store_id" },
      { key: "brands", column: "co.brand" },
      { key: "quality", column: "co.quality" },
      { key: "priceAccess", column: "co.price_access" },
    ];

    const facetFor = (key: (typeof dims)[number]["key"], column: string) => {
      const { joins, where, params } = this.buildOfferFilters(input, key);
      const clauses = [...where, `${column} IS NOT NULL`];
      const whereSql = `WHERE ${clauses.join(" AND ")}`;
      const rows = this.db
        .query<{ value: string; count: number }, SQLQueryBindings[]>(
          `SELECT ${column} AS value, COUNT(*) AS count FROM current_offers co${joins} ${whereSql}
             GROUP BY ${column} ORDER BY count DESC`,
        )
        .all(...params);
      return rows;
    };

    // Category facet needs a join to product_categories/categories for a label.
    const { joins: catJoins, where: catWhere, params: catParams } = this.buildOfferFilters(input, "categoryIds");
    const catWhereSql = catWhere.length ? `WHERE ${catWhere.join(" AND ")}` : "";
    const categories = this.db
      .query<{ value: number; label: string; count: number }, SQLQueryBindings[]>(
        `SELECT c.id AS value, c.name AS label, COUNT(DISTINCT co.product_id) AS count
           FROM current_offers co${catJoins}
           JOIN product_categories pc ON pc.product_id = co.product_id
           JOIN categories c ON c.id = pc.category_id
           ${catWhereSql}
          GROUP BY c.id, c.name ORDER BY count DESC`,
      )
      .all(...catParams);

    return {
      stores: facetFor("stores", "co.store_id").map((r) => ({ value: r.value as StoreId, count: r.count })),
      brands: facetFor("brands", "co.brand").map((r) => ({ value: r.value, count: r.count })),
      categories,
      quality: facetFor("quality", "co.quality").map((r) => ({ value: r.value as OfferSummary["quality"], count: r.count })),
      priceAccess: facetFor("priceAccess", "co.price_access").map((r) => ({
        value: r.value as OfferSummary["priceAccess"],
        count: r.count,
      })),
    };
  }

  searchOffers(input: OfferSearchInput): OfferSearchPage {
    const { joins, where, params } = this.buildOfferFilters(input);
    const facets = this.computeOfferFacets(input);

    const keysetWhere: string[] = [];
    const keysetParams: SQLQueryBindings[] = [];
    let cursorKey: OfferCursorKey | undefined;
    if (input.cursor) {
      cursorKey = decodeOfferCursor(input.cursor, input, input.sort);
    }

    let orderClause: string;
    let rankSelect = "0 AS rank";
    if (input.sort === "relevance") {
      rankSelect = "bm25(products_fts) AS rank";
      orderClause = "rank ASC, co.product_id ASC";
      if (cursorKey && cursorKey.sort === "relevance") {
        keysetWhere.push("(bm25(products_fts) > ? OR (bm25(products_fts) = ? AND co.product_id > ?))");
        keysetParams.push(cursorKey.rank, cursorKey.rank, cursorKey.productId);
      }
    } else if (input.sort === "discount_desc") {
      orderClause = "COALESCE(co.discount_bps, -1) DESC, co.product_id ASC";
      if (cursorKey && cursorKey.sort === "discount_desc") {
        keysetWhere.push(
          "(COALESCE(co.discount_bps, -1) < ? OR (COALESCE(co.discount_bps, -1) = ? AND co.product_id > ?))",
        );
        keysetParams.push(cursorKey.discountBps, cursorKey.discountBps, cursorKey.productId);
      }
    } else if (input.sort === "price_asc") {
      orderClause = "co.effective_cents ASC, co.product_id ASC";
      if (cursorKey && cursorKey.sort === "price_asc") {
        keysetWhere.push("(co.effective_cents > ? OR (co.effective_cents = ? AND co.product_id > ?))");
        keysetParams.push(cursorKey.effectiveCents, cursorKey.effectiveCents, cursorKey.productId);
      }
    } else if (input.sort === "price_desc") {
      orderClause = "co.effective_cents DESC, co.product_id ASC";
      if (cursorKey && cursorKey.sort === "price_desc") {
        keysetWhere.push("(co.effective_cents < ? OR (co.effective_cents = ? AND co.product_id > ?))");
        keysetParams.push(cursorKey.effectiveCents, cursorKey.effectiveCents, cursorKey.productId);
      }
    } else {
      orderClause = "co.latest_price_observed_at DESC, co.product_id ASC";
      if (cursorKey && cursorKey.sort === "updated_desc") {
        keysetWhere.push(
          "(co.latest_price_observed_at < ? OR (co.latest_price_observed_at = ? AND co.product_id > ?))",
        );
        const iso = new Date(cursorKey.observedAtMs).toISOString();
        keysetParams.push(iso, iso, cursorKey.productId);
      }
    }

    const allWhere = [...where, ...keysetWhere];
    const whereSql = allWhere.length ? `WHERE ${allWhere.join(" AND ")}` : "";
    const limit = input.limit;
    const sql = `SELECT co.*, ${rankSelect} FROM current_offers co${joins} ${whereSql} ORDER BY ${orderClause} LIMIT ?`;
    const rows = this.db
      .query<CurrentOfferRow & { rank: number }, SQLQueryBindings[]>(sql)
      .all(...params, ...keysetParams, limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];

    let nextCursor: string | null = null;
    if (hasMore && lastRow) {
      let key: OfferCursorKey;
      if (input.sort === "relevance") key = { sort: "relevance", rank: lastRow.rank, productId: lastRow.product_id };
      else if (input.sort === "discount_desc")
        key = { sort: "discount_desc", discountBps: lastRow.discount_bps ?? -1, productId: lastRow.product_id };
      else if (input.sort === "price_asc" || input.sort === "price_desc")
        key = { sort: input.sort, effectiveCents: lastRow.effective_cents, productId: lastRow.product_id };
      else key = { sort: "updated_desc", observedAtMs: Date.parse(lastRow.latest_price_observed_at), productId: lastRow.product_id };
      nextCursor = encodeOfferCursor(input, key);
    }

    return { data: page.map((r) => this.toOfferSummary(r)), nextCursor, facets };
  }

  getOfferHistory(productId: number): OfferHistory {
    const rows = this.db
      .query<PriceRow, SQLQueryBindings[]>(
        "SELECT * FROM price_observations WHERE product_id=? ORDER BY observed_at ASC, id ASC",
      )
      .all(productId);
    let publicLow: number | null = null;
    let cardLow: number | null = null;
    const observations = rows.map((r) => {
      const derived = deriveOffer({
        regularCents: r.regular_cents,
        offerCents: r.offer_cents,
        cardCents: r.card_cents,
      });
      const publicCandidate = r.offer_cents ?? r.regular_cents;
      const cardCandidate = r.card_cents;
      if (publicCandidate != null) publicLow = publicLow == null ? publicCandidate : Math.min(publicLow, publicCandidate);
      if (cardCandidate != null) cardLow = cardLow == null ? cardCandidate : Math.min(cardLow, cardCandidate);
      return {
        observedAt: r.observed_at,
        regularCents: r.regular_cents,
        offerCents: r.offer_cents,
        cardCents: r.card_cents,
        publicEffectiveCents: publicCandidate,
        cardEffectiveCents: cardCandidate,
        quality: derived?.quality ?? null,
        discountCents: derived?.discountCents ?? null,
        discountBps: derived?.discountBps ?? null,
        inStock: r.in_stock === 1,
      };
    });
    return { observations, publicHistoricalLowCents: publicLow, cardHistoricalLowCents: cardLow };
  }

  listTargets(options: { store?: StoreId; limit?: number } = {}): TargetIdentity[] {
    const limit = clampLimit(options.limit);
    const rows = options.store
      ? this.db
          .query<TargetIdentityRow, [StoreId, number]>(
            "SELECT * FROM scrape_target_identities WHERE store_id=? ORDER BY id DESC LIMIT ?",
          )
          .all(options.store, limit)
      : this.db
          .query<TargetIdentityRow, [number]>(
            "SELECT * FROM scrape_target_identities ORDER BY id DESC LIMIT ?",
          )
          .all(limit);
    return rows.map((row) => this.toTargetIdentity(row));
  }

  getTarget(targetId: number): TargetIdentity | null {
    const row = this.db
      .query<TargetIdentityRow, [number]>(
        "SELECT * FROM scrape_target_identities WHERE id=?",
      )
      .get(targetId);
    return row ? this.toTargetIdentity(row) : null;
  }

  private toTargetIdentity(row: TargetIdentityRow): TargetIdentity {
    return TargetIdentitySchema.parse({
      id: row.id,
      storeId: row.store_id,
      identityKey: row.identity_key,
      target: TargetIdentityInputSchema.parse(JSON.parse(row.target_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  listTargetCoverages(targetId: number, options: { limit?: number } = {}): TargetCoverage[] {
    const rows = this.db
      .query<TargetCoverageRow, [number, number]>(
        "SELECT * FROM target_coverages WHERE target_id=? ORDER BY started_at DESC, id DESC LIMIT ?",
      )
      .all(targetId, clampLimit(options.limit));
    return rows.map((row) =>
      TargetCoverageSchema.parse({
        id: row.id,
        runId: row.run_id,
        targetId: row.target_id,
        status: row.status,
        authoritative: row.authoritative === 1,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        maxRequests: row.max_requests,
        maxDurationMs: row.max_duration_ms,
        requestedPages: parseNullableJson(row.requested_pages_json),
        requestsMade: row.requests_made,
        productsSeen: row.products_seen,
        duplicatesSeen: row.duplicates_seen,
        productsRejected: row.products_rejected,
        stopReason: row.stop_reason,
        boundary: parseNullableJson(row.boundary_json),
      }),
    );
  }

  getCoverageOfferHandoff(
    coverageId: number,
    options: { cursor?: string; limit?: number } = {},
  ): CoverageOfferHandoff {
    const input = CoverageOfferHandoffQuerySchema.parse(options);
    const meta = this.db
      .query<CoverageHandoffMetaRow, [number]>(
        `SELECT c.*, r.invocation_id, r.store_id
           FROM target_coverages c
           JOIN scraper_runs r ON r.id=c.run_id
           JOIN scrape_target_identities t ON t.id=c.target_id AND t.store_id=r.store_id
          WHERE c.id=?`,
      )
      .get(coverageId);
    if (!meta) {
      throw new ScrapError("COVERAGE_NOT_FOUND", `coverage not found: ${coverageId}`);
    }
    if (meta.invocation_id == null) {
      throw new ScrapError(
        "COVERAGE_HANDOFF_UNAVAILABLE",
        `coverage ${coverageId} belongs to a legacy run without invocationId`,
      );
    }
    const missingIdentitySnapshot = this.db
      .query<{ id: number }, [number]>(
        `SELECT id
           FROM product_sightings
          WHERE coverage_id=?
            AND (
              identity_snapshot_version IS NOT 1
              OR name_snapshot IS NULL
              OR canonical_url_snapshot IS NULL
            )
          LIMIT 1`,
      )
      .get(coverageId);
    if (missingIdentitySnapshot) {
      throw new ScrapError(
        "COVERAGE_HANDOFF_UNAVAILABLE",
        `coverage ${coverageId} contains legacy sightings without immutable identity snapshots`,
      );
    }

    const cursor = input.cursor ? decodeCoverageOfferCursor(input.cursor, coverageId) : null;
    const keyset = cursor
      ? " AND (ps.product_id > ? OR (ps.product_id = ? AND ps.id > ?))"
      : "";
    const params: SQLQueryBindings[] = [coverageId];
    if (cursor) params.push(cursor.productId, cursor.productId, cursor.sightingId);
    params.push(input.limit + 1);

    const rows = this.db
      .query<CoverageHandoffOfferRow, SQLQueryBindings[]>(
        `SELECT m.*,
                ps.id AS sighting_id,
                ps.coverage_id,
                ps.seen_at,
                ps.source_hash AS sighting_source_hash,
                p.store_id,
                p.external_id,
                ps.name_snapshot,
                ps.brand_snapshot,
                ps.canonical_url_snapshot,
                ps.seller_id_snapshot,
                ps.seller_name_snapshot
           FROM product_sightings ps
           JOIN products p ON p.id=ps.product_id
           JOIN price_observation_movements m
             ON m.id=ps.price_observation_id
            AND m.product_id=ps.product_id
          WHERE ps.coverage_id=?${keyset}
          ORDER BY ps.product_id ASC, ps.id ASC
          LIMIT ?`,
      )
      .all(...params);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];

    return CoverageOfferHandoffSchema.parse({
      invocationId: meta.invocation_id,
      runId: meta.run_id,
      site: meta.store_id,
      coverage: {
        coverageId: meta.id,
        status: meta.status,
        authoritative: meta.authoritative === 1,
        startedAt: meta.started_at,
        finishedAt: meta.finished_at,
        boundary: parseNullableJson(meta.boundary_json),
        stopReason: meta.stop_reason,
      },
      data: page.map((row) => {
        const currentHistoricalLowCents =
          row.effective_cents == null
            ? row.prior_historical_low_cents
            : row.prior_historical_low_cents == null
              ? row.effective_cents
              : Math.min(row.prior_historical_low_cents, row.effective_cents);
        return {
          productId: row.product_id,
          storeId: row.store_id,
          externalId: row.external_id,
          name: row.name_snapshot,
          brand: row.brand_snapshot,
          seller: {
            id: row.seller_id_snapshot,
            name: row.seller_name_snapshot,
          },
          url: row.canonical_url_snapshot,
          currency: "PEN",
          price: {
            observationId: row.id,
            observedAt: row.observed_at,
            regularCents: row.regular_cents,
            offerCents: row.offer_cents,
            cardCents: row.card_cents,
            effectiveCents: row.effective_cents,
            access: row.price_access,
            inStock: row.in_stock === 1,
          },
          movement: {
            previousObservationId: row.previous_price_observation_id,
            previousEffectiveCents: row.previous_effective_cents,
            previousAccess: row.previous_price_access,
            priorHistoricalLowCents: row.prior_historical_low_cents,
            currentHistoricalLowCents,
            isPriceDrop: row.is_price_drop === 1,
            isHistoricalLow: row.is_historical_low === 1,
            sellerChanged: row.seller_changed === 1,
          },
          evidence: {
            sightingId: row.sighting_id,
            seenAt: row.seen_at,
            coverageId: row.coverage_id,
            sourceHash: row.sighting_source_hash,
          },
        };
      }),
      nextCursor:
        hasMore && last
          ? encodeCoverageOfferCursor({
              coverageId,
              productId: last.product_id,
              sightingId: last.sighting_id,
            })
          : null,
    });
  }

  listProductSightings(productId: number, options: { limit?: number } = {}): ProductSighting[] {
    const rows = this.db
      .query<ProductSightingRow, [number, number]>(
        "SELECT * FROM product_sightings WHERE product_id=? ORDER BY seen_at DESC, id DESC LIMIT ?",
      )
      .all(productId, clampLimit(options.limit));
    return rows.map((row) =>
      ProductSightingSchema.parse({
        id: row.id,
        coverageId: row.coverage_id,
        productId: row.product_id,
        priceObservationId: row.price_observation_id,
        seenAt: row.seen_at,
        sourceHash: row.source_hash,
      }),
    );
  }

  listTargetMemberships(
    targetId: number,
    options: { includeInactive?: boolean; limit?: number } = {},
  ): TargetMembership[] {
    const inactiveClause = options.includeInactive ? "" : " AND inactive_at IS NULL";
    const rows = this.db
      .query<TargetMembershipRow, SQLQueryBindings[]>(
        `SELECT * FROM target_product_memberships
          WHERE target_id=?${inactiveClause}
          ORDER BY product_id LIMIT ?`,
      )
      .all(targetId, clampLimit(options.limit));
    return rows.map((row) =>
      TargetMembershipSchema.parse({
        targetId: row.target_id,
        productId: row.product_id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lastSeenCoverageId: row.last_seen_coverage_id,
        consecutiveCompleteMisses: row.consecutive_complete_misses,
        inactiveAt: row.inactive_at,
        inactivityReason: row.inactivity_reason,
      }),
    );
  }

  getPriceMovements(productId: number): PriceMovement[] {
    const rows = this.db
      .query<PriceMovementRow, [number]>(
        `SELECT * FROM price_observation_movements
          WHERE product_id=? ORDER BY observed_at ASC, id ASC`,
      )
      .all(productId);
    return rows.map((row) => this.toPriceMovement(row));
  }

  searchCurrentPriceDrops(
    options: { store?: StoreId; seenAfter?: string; limit?: number } = {},
  ): CurrentPriceDrop[] {
    const limit = clampLimit(options.limit);
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (options.store) {
      clauses.push("p.store_id=?");
      params.push(options.store);
    }
    if (options.seenAfter) {
      clauses.push("d.last_sighted_at>=?");
      params.push(options.seenAfter);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT d.*, p.store_id, p.external_id, p.name, p.brand,
                        p.seller_name, p.canonical_url
                   FROM current_price_drops d
                   JOIN products p ON p.id=d.product_id
                   ${where}
                  ORDER BY d.observed_at DESC, d.id DESC LIMIT ?`;
    const rows = this.db
      .query<
        CurrentPriceDropRow & {
          store_id: StoreId;
          external_id: string;
          name: string;
          brand: string | null;
          seller_name: string | null;
          canonical_url: string;
        },
        SQLQueryBindings[]
      >(sql)
      .all(...params, limit);
    return rows.map((row) =>
      CurrentPriceDropSchema.parse({
        ...this.toPriceMovement(row),
        storeId: row.store_id,
        externalId: row.external_id,
        name: row.name,
        brand: row.brand,
        sellerName: row.seller_name,
        canonicalUrl: row.canonical_url,
        lastSightedAt: row.last_sighted_at,
        coverageId: row.coverage_id,
      }),
    );
  }

  private toPriceMovement(row: PriceMovementRow): PriceMovement {
    return PriceMovementSchema.parse({
      priceObservationId: row.id,
      productId: row.product_id,
      observedAt: row.observed_at,
      regularCents: row.regular_cents,
      offerCents: row.offer_cents,
      cardCents: row.card_cents,
      sellerId: row.seller_id,
      inStock: row.in_stock === 1,
      effectiveCents: row.effective_cents,
      priceAccess: row.price_access,
      previousPriceObservationId: row.previous_price_observation_id,
      previousEffectiveCents: row.previous_effective_cents,
      previousPriceAccess: row.previous_price_access,
      previousSellerId: row.previous_seller_id,
      previousInStock: row.previous_in_stock == null ? null : row.previous_in_stock === 1,
      priorHistoricalLowCents: row.prior_historical_low_cents,
      isPriceDrop: row.is_price_drop === 1,
      isHistoricalLow: row.is_historical_low === 1,
      sellerChanged: row.seller_changed === 1,
    });
  }
}
