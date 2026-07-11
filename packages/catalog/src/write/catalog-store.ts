/**
 * CatalogStore — all catalog/history/variant/image-source persistence. The
 * only public write is `productSnapshot`, which commits one normalized
 * product, its authoritative-or-preserved variants, canonical image sources,
 * and run-owned image destination targets in a single short synchronous
 * transaction (no network/image I/O inside). Price observations are
 * append-only but change-gated. A source failure never rolls back
 * product/variant rows (images are drained separately by ImageWorker).
 */
import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { CategoryInput, ImageInput, ProductInput, StoreId, VariantInput } from "@scrapito/contracts";
import type { ImageDestinationKind, ImageSourceTargetRow, ImageSourceRow, PriceRow, ProductRow, VariantRow } from "../rows.ts";

export interface SnapshotResult {
  productId: number;
  created: boolean;
  priceInserted: boolean;
  variantsUpserted: number;
  variantsDeactivated: number;
  imageTargetsLinked: number;
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

  /** Commit one validated product + categories + current price + variants +
   * run-owned image destinations atomically. `variants` must already be
   * validated (see `validateVariants` in @scrapito/contracts) — each entry is
   * trusted as-is. `variantsObserved` controls whether variants missing from
   * this snapshot are deactivated (true) or preserved (false). */
  productSnapshot(
    runId: number,
    store: StoreId,
    input: ProductInput,
    variants: readonly VariantInput[],
  ): SnapshotResult {
    const now = new Date().toISOString();
    const tx = this.db.transaction((): SnapshotResult => {
      const { id: productId, created } = this.upsertProduct(store, input, now);
      for (const cat of input.categories) {
        const categoryId = this.upsertCategory(store, cat);
        this.linkProductCategory(productId, categoryId);
      }
      const priceInserted = this.maybeInsertPrice(productId, input, now);

      let imageTargetsLinked = 0;
      for (const [i, img] of input.images.entries()) {
        if (this.linkImageTarget(runId, "product", productId, img, i)) imageTargetsLinked++;
      }

      const { upserted: variantsUpserted, deactivated: variantsDeactivated } = this.syncVariants(
        productId,
        variants,
        input.variantsObserved,
        now,
      );
      for (const variant of variants) {
        const variantId = this.variantIdFor(productId, variant.externalId);
        if (variantId == null) continue;
        for (const [i, img] of variant.images.entries()) {
          if (this.linkImageTarget(runId, "variant", variantId, img, i)) imageTargetsLinked++;
        }
      }

      return { productId, created, priceInserted, variantsUpserted, variantsDeactivated, imageTargetsLinked };
    });
    return tx();
  }

  private upsertProduct(store: StoreId, input: ProductInput, now: string): { id: number; created: boolean } {
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
      .query("INSERT INTO categories (store_id, external_id, parent_id, name, url) VALUES (?,?,?,?,?)")
      .run(store, cat.externalId, parentId, cat.name, cat.url ?? null);
    return Number(res.lastInsertRowid);
  }

  private linkProductCategory(productId: number, categoryId: number): void {
    this.db
      .query("INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)")
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

  /** Upsert every valid variant seen this snapshot; when `variantsObserved` is
   * true, deactivate any active variant for this product NOT in the seen set
   * (including deactivating all of them for an authoritative empty snapshot).
   * A non-authoritative (variantsObserved=false) snapshot never deactivates. */
  private syncVariants(
    productId: number,
    variants: readonly VariantInput[],
    variantsObserved: boolean,
    now: string,
  ): { upserted: number; deactivated: number } {
    let upserted = 0;
    const seenExternalIds: string[] = [];
    for (const v of variants) {
      seenExternalIds.push(v.externalId);
      const existing = this.db
        .query<IdRow, SQLQueryBindings[]>(
          "SELECT id FROM product_variants WHERE product_id=? AND external_id=?",
        )
        .get(productId, v.externalId);
      if (existing) {
        this.db
          .query(
            `UPDATE product_variants SET sku=?, name=?, color_name=?, color_hex=?, size=?,
               in_stock=?, attributes_json=?, active=1, last_seen_at=? WHERE id=?`,
          )
          .run(
            v.sku,
            v.name,
            v.colorName,
            v.colorHex,
            v.size,
            v.inStock ? 1 : 0,
            JSON.stringify(v.attributes ?? {}),
            now,
            existing.id,
          );
      } else {
        this.db
          .query(
            `INSERT INTO product_variants
               (product_id, external_id, sku, name, color_name, color_hex, size, in_stock,
                attributes_json, active, first_seen_at, last_seen_at)
             VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
          )
          .run(
            productId,
            v.externalId,
            v.sku,
            v.name,
            v.colorName,
            v.colorHex,
            v.size,
            v.inStock ? 1 : 0,
            JSON.stringify(v.attributes ?? {}),
            now,
            now,
          );
      }
      upserted++;
    }

    let deactivated = 0;
    if (variantsObserved) {
      if (seenExternalIds.length === 0) {
        const res = this.db
          .query("UPDATE product_variants SET active=0 WHERE product_id=? AND active=1")
          .run(productId);
        deactivated = Number(res.changes);
      } else {
        const placeholders = seenExternalIds.map(() => "?").join(",");
        const res = this.db
          .query(
            `UPDATE product_variants SET active=0
               WHERE product_id=? AND active=1 AND external_id NOT IN (${placeholders})`,
          )
          .run(productId, ...seenExternalIds);
        deactivated = Number(res.changes);
      }
    }
    return { upserted, deactivated };
  }

  private variantIdFor(productId: number, externalId: string): number | undefined {
    const row = this.db
      .query<IdRow, SQLQueryBindings[]>("SELECT id FROM product_variants WHERE product_id=? AND external_id=?")
      .get(productId, externalId);
    return row?.id;
  }

  /** Upsert a canonical image source by URL, then link a run-owned target for
   * this destination/position. Returns true when a new target link was
   * created (idempotent — replays of the same run/destination/position are
   * no-ops thanks to the partial unique index). */
  private linkImageTarget(
    runId: number,
    kind: ImageDestinationKind,
    destinationId: number,
    img: ImageInput,
    position: number,
  ): boolean {
    const now = new Date().toISOString();
    const sourceRow = this.db
      .query<IdRow, SQLQueryBindings[]>(
        `INSERT INTO image_sources (url, status, created_at) VALUES (?, 'pending', ?)
           ON CONFLICT(url) DO UPDATE SET url = excluded.url
         RETURNING id`,
      )
      .get(img.url, now);
    if (!sourceRow) return false;
    const res = this.db
      .query(
        `INSERT INTO image_source_targets (source_id, run_id, destination_kind, destination_id, position, alt)
           VALUES (?,?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
      )
      .run(sourceRow.id, runId, kind, destinationId, img.position ?? position, img.alt ?? null);
    return Number(res.changes) > 0;
  }

  // ---- Internal read/write helpers used by the image worker ----

  /** Pending image sources owned (via a target) by the given run. */
  claimPendingImageSourcesForRun(runId: number, limit: number): ImageSourceRow[] {
    return this.db
      .query<ImageSourceRow, SQLQueryBindings[]>(
        `SELECT DISTINCT s.* FROM image_sources s
           JOIN image_source_targets t ON t.source_id = s.id
          WHERE t.run_id = ? AND s.status = 'pending'
          ORDER BY s.id LIMIT ?`,
      )
      .all(runId, limit);
  }

  targetsForSource(sourceId: number): ImageSourceTargetRow[] {
    return this.db
      .query<ImageSourceTargetRow, SQLQueryBindings[]>("SELECT * FROM image_source_targets WHERE source_id=?")
      .all(sourceId);
  }

  markImageSourceDone(id: number, sha256: string): void {
    this.db
      .query("UPDATE image_sources SET status='done', sha256=?, last_error=NULL WHERE id=?")
      .run(sha256, id);
  }

  markImageSourceFailed(id: number, error: string): void {
    this.db
      .query("UPDATE image_sources SET status='failed', attempts=attempts+1, last_error=? WHERE id=?")
      .run(error, id);
  }

  updateImageSourceValidators(id: number, etag: string | null, lastModified: string | null): void {
    this.db.query("UPDATE image_sources SET etag=?, last_modified=? WHERE id=?").run(etag, lastModified, id);
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
      .run(row.sha256, row.byteSize, row.mime, row.width, row.height, row.relativePath, new Date().toISOString());
    return true;
  }

  /** Link a downloaded image to every product/variant target for its source. */
  linkImageToTargets(sourceId: number, sha256: string): void {
    const targets = this.targetsForSource(sourceId);
    for (const t of targets) {
      if (t.destination_kind === "product") {
        this.db
          .query("INSERT OR IGNORE INTO product_images (product_id, sha256, position) VALUES (?,?,?)")
          .run(t.destination_id, sha256, t.position);
      } else {
        this.db
          .query(
            "INSERT OR IGNORE INTO variant_images (variant_id, sha256, position) VALUES (?,?,?)",
          )
          .run(t.destination_id, sha256, t.position);
      }
    }
  }
}
