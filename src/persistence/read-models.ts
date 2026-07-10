import type { Currency, StoreId } from "../domain/ids.ts";

export interface ProductSummary {
  id: number;
  storeId: StoreId;
  externalId: string;
  name: string;
  brand: string | null;
  sellerName: string | null;
  canonicalUrl: string;
  regularCents: number | null;
  offerCents: number | null;
  cardCents: number | null;
  currency: Currency;
  inStock: boolean;
  imageUrl: string | null;
  lastSeenAt: string;
}

export interface PriceObservation {
  observedAt: string;
  regularCents: number | null;
  offerCents: number | null;
  cardCents: number | null;
  currency: Currency;
  sellerId: string | null;
  inStock: boolean;
}

export interface ProductImageRef {
  sha256: string;
  position: number;
  mime: string;
  url: string;
}

export interface ProductDetail extends ProductSummary {
  attributes: Record<string, unknown>;
  prices: PriceObservation[];
  images: ProductImageRef[];
}

export interface JobView {
  id: number;
  scraperId: string;
  status: string;
  attempts: number;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  productsSaved: number;
  productsRejected: number;
  lastError: string | null;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
