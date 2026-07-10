/**
 * CatalogStore — all catalog/history/image-source persistence. The only public
 * write is `productSnapshot`, which commits one normalized product, its category
 * links, and its current price in a single short synchronous transaction (no
 * network/image I/O inside). Price observations are append-only but change-gated.
 *
 * Row typing uses bun:sqlite's typed `query<Row>()` generic so results are typed
 * without unchecked inline casts.
 */
import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { StoreId } from "../domain/ids.ts";
import type { CategoryInput, ImageInput, ProductInput } from "../domain/schemas.ts";
import type { ImageSourceRow, PriceRow, ProductRow } from "./rows.ts";

export interface SnapshotResult {
  productId: number;
  created: boolean;
  priceInserted: boolean;
  imageSourcesQueued: number;
}

interface IdRow {
  id: number;
}

function samePrice(prev: PriceRow | undefined, next: ProductInput["price"]): boolean {
  if (!prev) return false;
  return (
    (prev.regular_cents ?? null) === (next.regularCents ?? null) &&
    (prev.offer_cents ?? null) === (next.offerCents ?? null) &&
    (prev.card_cents ?? null) === (next.cardCents ?? null) &&
    (prev.seller_id ?? null) === (next.sellerId ?? null) &&
    prev.in_stock === (next.inStock ? 1 : 0)
  );
}

export class CatalogStore {
  constructor(private readonly db: Database) {}

  /** Commit one validated product + categories + current price atomically. */
  productSnapshot(store: StoreId, input: ProductInput): SnapshotResult {
    const now = new Date().toISOString();
    const tx = this.db.transaction((): SnapshotResult => {
      const { id: productId, created } = this.upsertProduct(store, input, now);
      let queued = 0;
      for (const cat of input.categories) {
        const categoryId = this.upsertCategory(store, cat);
        this.linkProductCategory(productId, categoryId);
      }
      const priceInserted = this.maybeInsertPrice(productId, input, now);
      for (const img of input.images) {
        if (this.upsertImageSource(productId, img, now)) queued++;
      }
      return { productId, created, priceInserted, imageSourcesQueued: queued };
    });
    return tx();
  }

  private upsertProduct(
    store: StoreId,
    input: ProductInput,
    now: string,
  ): { id: number; created: boolean } {
    const existing = this.db
      .query<ProductRow, SQLQueryBindings[]>("SELECT * FROM products WHERE store_id = ? AND external_id = ?")
      .get(store, input.externalId);

    if (existing) {
      this.db
        .query(
          `UPDATE products SET canonical_url=?, name=?, brand=?, seller_id=?, seller_name=?,
             sponsored=?, attributes_json=?, source_hash=?, last_seen_at=? WHERE id=?`,
        )
        .run(
          input.canonicalUrl,
          input.name,
          input.brand ?? null,
          input.sellerId ?? null,
          input.sellerName ?? null,
          input.sponsored ? 1 : 0,
          JSON.stringify(input.attributes ?? {}),
          input.sourceHash ?? null,
          now,
          existing.id,
        );
      return { id: existing.id, created: false };
    }

    const res = this.db
      .query(
        `INSERT INTO products
           (store_id, external_id, canonical_url, name, brand, seller_id, seller_name,
            sponsored, attributes_json, source_hash, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        store,
        input.externalId,
        input.canonicalUrl,
        input.name,
        input.brand ?? null,
        input.sellerId ?? null,
        input.sellerName ?? null,
        input.sponsored ? 1 : 0,
        JSON.stringify(input.attributes ?? {}),
        input.sourceHash ?? null,
        now,
        now,
      );
    return { id: Number(res.lastInsertRowid), created: true };
  }

  private upsertCategory(store: StoreId, cat: CategoryInput): number {
    let parentId: number | null = null;
    if (cat.parentExternalId) {
      const parent = this.db
        .query<IdRow, SQLQueryBindings[]>("SELECT id FROM categories WHERE store_id=? AND external_id=?")
        .get(store, cat.parentExternalId);
      parentId = parent?.id ?? null;
    }
    const existing = this.db
      .query<IdRow, SQLQueryBindings[]>("SELECT id FROM categories WHERE store_id=? AND external_id=?")
      .get(store, cat.externalId);
    if (existing) {
      this.db
        .query("UPDATE categories SET name=?, url=?, parent_id=? WHERE id=?")
        .run(cat.name, cat.url ?? null, parentId, existing.id);
      return existing.id;
    }
    const res = this.db
      .query(
        "INSERT INTO categories (store_id, external_id, parent_id, name, url) VALUES (?,?,?,?,?)",
      )
      .run(store, cat.externalId, parentId, cat.name, cat.url ?? null);
    return Number(res.lastInsertRowid);
  }

  private linkProductCategory(productId: number, categoryId: number): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)",
      )
      .run(productId, categoryId);
  }

  private maybeInsertPrice(productId: number, input: ProductInput, now: string): boolean {
    const latest = this.db
      .query<PriceRow, SQLQueryBindings[]>(
        "SELECT * FROM price_observations WHERE product_id=? ORDER BY observed_at DESC, id DESC LIMIT 1",
      )
      .get(productId);
    if (samePrice(latest ?? undefined, input.price)) return false;
    this.db
      .query(
        `INSERT INTO price_observations
           (product_id, observed_at, regular_cents, offer_cents, card_cents, currency, seller_id, in_stock, raw_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        productId,
        now,
        input.price.regularCents ?? null,
        input.price.offerCents ?? null,
        input.price.cardCents ?? null,
        input.price.currency,
        input.price.sellerId ?? null,
        input.price.inStock ? 1 : 0,
        input.price.raw !== undefined ? JSON.stringify(input.price.raw) : null,
      );
    return true;
  }

  /** Register an image source for later download. Returns true when newly queued. */
  private upsertImageSource(productId: number, img: ImageInput, now: string): boolean {
    const existing = this.db
      .query<IdRow, SQLQueryBindings[]>("SELECT id FROM image_sources WHERE product_id=? AND url=?")
      .get(productId, img.url);
    if (existing) return false;
    this.db
      .query(
        `INSERT INTO image_sources (product_id, url, position, alt, status, created_at)
         VALUES (?,?,?,?, 'pending', ?)`,
      )
      .run(productId, img.url, img.position ?? null, img.alt ?? null, now);
    return true;
  }

  // ---- Internal read helpers used by the image worker ----

  claimPendingImageSources(limit: number): ImageSourceRow[] {
    return this.db
      .query<ImageSourceRow, SQLQueryBindings[]>(
        "SELECT * FROM image_sources WHERE status='pending' ORDER BY id LIMIT ?",
      )
      .all(limit);
  }

  markImageSourceDone(id: number, sha256: string): void {
    this.db
      .query("UPDATE image_sources SET status='done', sha256=?, last_error=NULL WHERE id=?")
      .run(sha256, id);
  }

  markImageSourceFailed(id: number, error: string): void {
    this.db
      .query(
        "UPDATE image_sources SET status='failed', attempts=attempts+1, last_error=? WHERE id=?",
      )
      .run(error, id);
  }

  updateImageSourceValidators(id: number, etag: string | null, lastModified: string | null): void {
    this.db
      .query("UPDATE image_sources SET etag=?, last_modified=? WHERE id=?")
      .run(etag, lastModified, id);
  }

  upsertImage(row: {
    sha256: string;
    byteSize: number;
    mime: string;
    width: number | null;
    height: number | null;
    relativePath: string;
  }): boolean {
    const existing = this.db
      .query<{ sha256: string }, SQLQueryBindings[]>("SELECT sha256 FROM images WHERE sha256=?")
      .get(row.sha256);
    if (existing) return false;
    this.db
      .query(
        `INSERT INTO images (sha256, byte_size, mime, width, height, relative_path, first_seen_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        row.sha256,
        row.byteSize,
        row.mime,
        row.width,
        row.height,
        row.relativePath,
        new Date().toISOString(),
      );
    return true;
  }

  linkProductImage(productId: number, sha256: string, position: number): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO product_images (product_id, sha256, position) VALUES (?,?,?)",
      )
      .run(productId, sha256, position);
  }

  productIdForImageSource(imageSourceId: number): number | undefined {
    const row = this.db
      .query<{ product_id: number }, SQLQueryBindings[]>("SELECT product_id FROM image_sources WHERE id=?")
      .get(imageSourceId);
    return row?.product_id;
  }
}
