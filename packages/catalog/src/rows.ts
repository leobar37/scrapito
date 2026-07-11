/** Raw SQLite row shapes shared by the read and write sides. */
import type { StoreId } from "@scrapito/contracts";

export interface ProductRow {
  id: number;
  store_id: StoreId;
  external_id: string;
  canonical_url: string;
  name: string;
  brand: string | null;
  seller_id: string | null;
  seller_name: string | null;
  sponsored: number;
  attributes_json: string;
  source_hash: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PriceRow {
  id: number;
  product_id: number;
  observed_at: string;
  regular_cents: number | null;
  offer_cents: number | null;
  card_cents: number | null;
  currency: string;
  seller_id: string | null;
  in_stock: number;
  raw_json: string | null;
}

export interface ImageRow {
  sha256: string;
  byte_size: number;
  mime: string;
  width: number | null;
  height: number | null;
  relative_path: string;
  first_seen_at: string;
}

/** Canonical, download-state row for one URL (no product/variant ownership). */
export interface ImageSourceRow {
  id: number;
  url: string;
  sha256: string | null;
  etag: string | null;
  last_modified: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export type ImageDestinationKind = "product" | "variant";

export interface ImageSourceTargetRow {
  id: number;
  source_id: number;
  run_id: number | null;
  destination_kind: ImageDestinationKind;
  destination_id: number;
  position: number;
  alt: string | null;
}

export interface VariantRow {
  id: number;
  product_id: number;
  external_id: string;
  sku: string | null;
  name: string | null;
  color_name: string | null;
  color_hex: string | null;
  size: string | null;
  in_stock: number;
  attributes_json: string;
  active: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface VariantImageRow {
  variant_id: number;
  sha256: string;
  position: number;
}

export interface RunRow {
  id: number;
  scraper_id: string;
  store_id: StoreId;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  products_saved: number;
  products_rejected: number;
  requests_made: number;
  images_downloaded: number;
  last_error: string | null;
}

export interface WriterLeaseRow {
  name: string;
  token: string;
  expires_at: number;
  heartbeat_at: number;
}

/** One row of the `current_offers` SQL view (see 0004_offer_search.sql). */
export interface CurrentOfferRow {
  product_id: number;
  store_id: StoreId;
  external_id: string;
  name: string;
  brand: string | null;
  seller_name: string | null;
  canonical_url: string;
  last_seen_at: string;
  latest_price_observed_at: string;
  regular_cents: number | null;
  offer_cents: number | null;
  card_cents: number | null;
  in_stock: number;
  effective_cents: number;
  price_access: "public" | "card";
  quality: "verified_discount" | "promotional_price";
  discount_cents: number | null;
  discount_bps: number | null;
}
