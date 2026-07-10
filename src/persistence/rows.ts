/** Raw SQLite row shapes. */
import type { StoreId } from "../domain/ids.ts";

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

export interface ImageSourceRow {
  id: number;
  product_id: number;
  url: string;
  position: number | null;
  alt: string | null;
  sha256: string | null;
  etag: string | null;
  last_modified: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  scraper_id: string;
  params_json: string;
  status: string;
  attempts: number;
  max_requests: number;
  max_duration_ms: number;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  products_saved: number;
  products_rejected: number;
  last_error: string | null;
  created_at: string;
}
