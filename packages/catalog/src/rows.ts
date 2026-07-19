/** Raw SQLite row shapes shared by the read and write sides. */
import type { CoverageStatus, CoverageStopReason, StoreId, TargetKind } from "@scrapito/contracts";

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
  description: string | null;
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

export interface TargetIdentityRow {
  id: number;
  store_id: StoreId;
  kind: TargetKind;
  identity_key: string;
  target_json: string;
  created_at: string;
  updated_at: string;
}

export interface TargetCoverageRow {
  id: number;
  run_id: number;
  target_id: number;
  status: CoverageStatus;
  authoritative: number;
  started_at: string;
  finished_at: string | null;
  max_requests: number | null;
  max_duration_ms: number | null;
  requested_pages_json: string | null;
  requests_made: number;
  products_seen: number;
  duplicates_seen: number;
  products_rejected: number;
  stop_reason: CoverageStopReason | null;
  boundary_json: string | null;
}

export interface ProductSightingRow {
  id: number;
  coverage_id: number;
  product_id: number;
  price_observation_id: number;
  seen_at: string;
  source_hash: string | null;
  name_snapshot: string | null;
  brand_snapshot: string | null;
  canonical_url_snapshot: string | null;
  seller_id_snapshot: string | null;
  seller_name_snapshot: string | null;
  identity_snapshot_version: number | null;
}

export interface TargetMembershipRow {
  target_id: number;
  product_id: number;
  first_seen_at: string;
  last_seen_at: string;
  last_seen_coverage_id: number;
  consecutive_complete_misses: number;
  inactive_at: string | null;
  inactivity_reason: "complete_coverage_miss" | "explicit_source_signal" | null;
}

export interface PriceMovementRow extends PriceRow {
  effective_cents: number | null;
  price_access: "public" | "card" | null;
  previous_price_observation_id: number | null;
  previous_effective_cents: number | null;
  previous_price_access: "public" | "card" | null;
  previous_seller_id: string | null;
  previous_in_stock: number | null;
  prior_historical_low_cents: number | null;
  is_price_drop: number;
  is_historical_low: number;
  seller_changed: number;
}

export interface CurrentPriceDropRow extends PriceMovementRow {
  last_sighted_at: string;
  coverage_id: number;
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
  invocation_id: string | null;
  strategy: string | null;
  capability: string | null;
  params_json: string | null;
  max_requests: number | null;
  max_duration_ms: number | null;
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
