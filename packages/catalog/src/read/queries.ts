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
  type OfferFacets,
  type OfferHistory,
  type OfferSearchInput,
  type OfferSearchPage,
  type OfferSummary,
  type Page,
  type PriceObservation,
  type ProductDetail,
  type ProductImageRef,
  type ProductSummary,
  type ProductVariant,
  type StoreFreshness,
  type StoreId,
  type UpdateRunSummary,
} from "@scrapito/contracts";
import type { CurrentOfferRow, ImageSourceRow, PriceRow, ProductRow, RunRow, VariantImageRow, VariantRow } from "../rows.ts";
import { decodeOfferCursor, encodeOfferCursor, type OfferCursorKey } from "./offer-cursor.ts";

const MAX_LIMIT = 100;

interface StoreRow {
  id: StoreId;
  name: string;
  base_url: string;
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
    return { ...summary, attributes: parseAttributes(p.attributes_json), prices, images, variants };
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
}
