import { z } from "zod";
import { CurrencySchema, StoreIdSchema } from "./ids.ts";

/** Allowlisted HTTPS hosts a canonical URL may point at. */
const ALLOWED_URL_HOSTS: Record<string, true> = {
  "simple.ripley.com.pe": true,
  "www.falabella.com.pe": true,
  "rimage.ripley.com.pe": true,
  "media.falabella.com": true,
  "media.falabella.com.pe": true,
};

/** A canonical HTTPS Peru URL restricted to the storefront/CDN allowlist. */
export const CanonicalUrlSchema = z
  .string()
  .url()
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" && ALLOWED_URL_HOSTS[u.hostname] === true;
    } catch {
      return false;
    }
  }, "URL must be HTTPS and target an allowlisted Peru host");

/** Integer céntimos (1/100 of a Sol). Non-negative. */
export const CentsSchema = z.number().int().nonnegative();

export const ImageInputSchema = z.object({
  /** Fully-qualified canonical HTTPS image URL on an allowlisted CDN host. */
  url: CanonicalUrlSchema,
  /** Optional caller-provided ordering hint (0-based). */
  position: z.number().int().nonnegative().optional(),
  /** Optional alt text captured from the source. */
  alt: z.string().optional(),
});
export type ImageInput = z.infer<typeof ImageInputSchema>;

export const PriceInputSchema = z
  .object({
    regularCents: CentsSchema.nullable().optional(),
    offerCents: CentsSchema.nullable().optional(),
    cardCents: CentsSchema.nullable().optional(),
    currency: CurrencySchema.default("PEN"),
    inStock: z.boolean().default(true),
    sellerId: z.string().min(1).nullable().optional(),
    /** Raw source payload retained for audit/change detection. */
    raw: z.unknown().optional(),
  })
  .refine(
    (p) =>
      p.regularCents != null || p.offerCents != null || p.cardCents != null,
    "at least one of regular/offer/card price is required",
  );
export type PriceInput = z.infer<typeof PriceInputSchema>;

export const CategoryInputSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  url: CanonicalUrlSchema.optional(),
  parentExternalId: z.string().min(1).nullable().optional(),
});
export type CategoryInput = z.infer<typeof CategoryInputSchema>;

export const ProductInputSchema = z.object({
  store: StoreIdSchema,
  /** Store-scoped external identifier / SKU. */
  externalId: z.string().min(1),
  canonicalUrl: CanonicalUrlSchema,
  name: z.string().min(1),
  brand: z.string().min(1).nullable().optional(),
  sellerId: z.string().min(1).nullable().optional(),
  sellerName: z.string().min(1).nullable().optional(),
  /** Whether the result came from a sponsored/marketing slot. */
  sponsored: z.boolean().default(false),
  attributes: z.record(z.unknown()).default({}),
  categories: z.array(CategoryInputSchema).default([]),
  images: z.array(ImageInputSchema).default([]),
  price: PriceInputSchema,
  /** SHA-256 of the source payload for change detection. */
  sourceHash: z.string().min(1).optional(),
  /** URL the product was captured from (may differ from canonicalUrl). */
  sourceUrl: CanonicalUrlSchema.optional(),
  /** HTTP validators captured at fetch time. */
  etag: z.string().nullable().optional(),
  lastModified: z.string().nullable().optional(),
  capturedAt: z.string().datetime().optional(),
});
export type ProductInput = z.infer<typeof ProductInputSchema>;

/** Per-page scraper result: valid products plus rejected diagnostics. */
export const ScrapePageResultSchema = z.object({
  url: z.string(),
  products: z.array(ProductInputSchema),
  rejected: z
    .array(z.object({ reason: z.string(), sample: z.unknown().optional() }))
    .default([]),
  /** True when the page-level assertion (expected shape) held. */
  ok: z.boolean().default(true),
});
export type ScrapePageResult = z.infer<typeof ScrapePageResultSchema>;

/** Page selection: single page, inclusive range, or explicit list. */
export const PagesSchema = z.union([
  z.number().int().positive(),
  z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
  z.array(z.number().int().positive()),
]);
export type Pages = z.infer<typeof PagesSchema>;

export const JobInputSchema = z.object({
  scraperId: z.string().min(1),
  category: z.string().min(1).optional(),
  pages: PagesSchema.optional(),
  downloadImages: z.boolean().optional(),
  maxRequests: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
});
export type JobInput = z.infer<typeof JobInputSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "retry_wait",
  "failed",
  "cancelled",
  "partial",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export { StoreIdSchema, CurrencySchema };
export type { StoreId } from "./ids.ts";
export type { Currency } from "./ids.ts";
