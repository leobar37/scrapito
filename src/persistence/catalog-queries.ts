/**
 * CatalogQueries — read-side queries backing the HTTP API. Returns typed DTOs
 * (never raw HTML). Uses cursor pagination keyed on ascending product/job id.
 */
import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { StoreId } from "../domain/ids.ts";
import { encodeCursor } from "./cursor.ts";
import type {
  JobView,
  Page,
  PriceObservation,
  ProductDetail,
  ProductImageRef,
  ProductSummary,
} from "./read-models.ts";
import type { JobRow, PriceRow, ProductRow } from "./rows.ts";

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

  listProducts(options: {
    store?: StoreId;
    afterId?: number;
    limit?: number;
  }): Page<ProductSummary> {
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
    return {
      data: page.map((p) => this.toSummary(p)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  getProduct(id: number): ProductDetail | null {
    const p = this.db.query<ProductRow, SQLQueryBindings[]>("SELECT * FROM products WHERE id=?").get(id);
    if (!p) return null;
    const summary = this.toSummary(p);
    const prices = this.getPrices(id);
    const images = this.getImages(id);
    let attributes: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(p.attributes_json);
      if (parsed && typeof parsed === "object") attributes = parsed as Record<string, unknown>;
    } catch {
      attributes = {};
    }
    return { ...summary, attributes, prices, images };
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
    return rows.map((r) => ({
      sha256: r.sha256,
      position: r.position,
      mime: r.mime,
      url: `/images/${r.sha256}`,
    }));
  }

  search(query: string, options: { limit?: number } = {}): ProductSummary[] {
    const limit = clampLimit(options.limit);
    const rows = this.db
      .query<ProductRow, SQLQueryBindings[]>(
        `SELECT p.* FROM products p
           JOIN products_fts f ON f.rowid = p.id
          WHERE products_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit);
    return rows.map((p) => this.toSummary(p));
  }

  stats(): Record<string, number> {
    const products = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM products").get()?.c ?? 0;
    const prices = this.db
      .query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM price_observations")
      .get()?.c ?? 0;
    const images = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM images").get()?.c ?? 0;
    const jobs = this.db.query<{ c: number }, SQLQueryBindings[]>("SELECT COUNT(*) c FROM scrape_jobs").get()?.c ?? 0;
    return { products, prices, images, jobs };
  }

  private toJobView(r: JobRow): JobView {
    return {
      id: r.id,
      scraperId: r.scraper_id,
      status: r.status,
      attempts: r.attempts,
      scheduledAt: r.scheduled_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      productsSaved: r.products_saved,
      productsRejected: r.products_rejected,
      lastError: r.last_error,
    };
  }

  listJobs(options: { afterId?: number; limit?: number }): Page<JobView> {
    const limit = clampLimit(options.limit);
    const after = options.afterId ?? 0;
    const rows = this.db
      .query<JobRow, SQLQueryBindings[]>("SELECT * FROM scrape_jobs WHERE id > ? ORDER BY id LIMIT ?")
      .all(after, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => this.toJobView(r)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  getJob(id: number): JobView | null {
    const r = this.db.query<JobRow, SQLQueryBindings[]>("SELECT * FROM scrape_jobs WHERE id=?").get(id);
    return r ? this.toJobView(r) : null;
  }

  getImageMeta(sha256: string): { relativePath: string; mime: string } | null {
    const r = this.db
      .query<{ relative_path: string; mime: string }, SQLQueryBindings[]>(
        "SELECT relative_path, mime FROM images WHERE sha256=?",
      )
      .get(sha256);
    return r ? { relativePath: r.relative_path, mime: r.mime } : null;
  }
}
