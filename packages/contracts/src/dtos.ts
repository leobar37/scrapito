import { z } from "zod";
import { CentsSchema } from "./schemas.ts";
import { CurrencySchema, StoreIdSchema } from "./ids.ts";

export const ProductVariantImageSchema = z.object({
  sha256: z.string(),
  position: z.number().int().nonnegative(),
  mime: z.string(),
  url: z.string(),
});
export type ProductVariantImage = z.infer<typeof ProductVariantImageSchema>;

/** Active, persisted product variant returned to API/web/CLI callers. */
export const ProductVariantSchema = z.object({
  id: z.number().int(),
  externalId: z.string(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  size: z.string().nullable(),
  inStock: z.boolean(),
  attributes: z.record(z.unknown()),
  images: z.array(ProductVariantImageSchema),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const ProductSummarySchema = z.object({
  id: z.number().int(),
  storeId: StoreIdSchema,
  externalId: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  sellerName: z.string().nullable(),
  canonicalUrl: z.string(),
  regularCents: CentsSchema.nullable(),
  offerCents: CentsSchema.nullable(),
  cardCents: CentsSchema.nullable(),
  currency: CurrencySchema,
  inStock: z.boolean(),
  imageUrl: z.string().nullable(),
  lastSeenAt: z.string(),
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const PriceObservationSchema = z.object({
  observedAt: z.string(),
  regularCents: CentsSchema.nullable(),
  offerCents: CentsSchema.nullable(),
  cardCents: CentsSchema.nullable(),
  currency: CurrencySchema,
  sellerId: z.string().nullable(),
  inStock: z.boolean(),
});
export type PriceObservation = z.infer<typeof PriceObservationSchema>;

export const ProductImageRefSchema = z.object({
  sha256: z.string(),
  position: z.number().int(),
  mime: z.string(),
  url: z.string(),
});
export type ProductImageRef = z.infer<typeof ProductImageRefSchema>;

export const ProductDetailSchema = ProductSummarySchema.extend({
  attributes: z.record(z.unknown()),
  prices: z.array(PriceObservationSchema),
  images: z.array(ProductImageRefSchema),
  variants: z.array(ProductVariantSchema),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

/** Generic opaque-cursor page envelope. */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

/** Generic opaque-cursor page envelope (TS-only convenience type). */
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
