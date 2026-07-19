import { z } from "zod";
import { CurrencySchema, StoreIdSchema } from "./ids.ts";

/** Allowlisted HTTPS hosts a canonical URL may point at. */
const ALLOWED_URL_HOSTS: Record<string, true> = {
  "simple.ripley.com.pe": true,
  "www.falabella.com.pe": true,
  "rimage.ripley.com.pe": true,
  "media.falabella.com": true,
  "media.falabella.com.pe": true,
  "www.promart.pe": true,
  "promart.vteximg.com.br": true,
  "www.oechsle.pe": true,
  "oechsle.vteximg.com.br": true,
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
    (p) => p.regularCents != null || p.offerCents != null || p.cardCents != null,
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

/** A single authoritative-or-not product variant observed on a list/detail page. */
export const VariantInputSchema = z.object({
  /** Store-scoped external identifier for this variant (never the parent product id). */
  externalId: z.string().min(1),
  sku: z.string().min(1).nullable(),
  name: z.string().min(1).nullable(),
  colorName: z.string().min(1).nullable(),
  colorHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable(),
  size: z.string().min(1).nullable(),
  inStock: z.boolean(),
  attributes: z.record(z.unknown()).default({}),
  images: z.array(ImageInputSchema).default([]),
});
export type VariantInput = z.infer<typeof VariantInputSchema>;

export const ProductInputSchema = z.object({
  store: StoreIdSchema,
  /** Store-scoped external identifier / SKU. */
  externalId: z.string().min(1),
  canonicalUrl: CanonicalUrlSchema,
  name: z.string().min(1),
  /** Free-text product description/long copy captured from the detail page. */
  description: z.string().min(1).nullable().optional(),
  brand: z.string().min(1).nullable().optional(),
  sellerId: z.string().min(1).nullable().optional(),
  sellerName: z.string().min(1).nullable().optional(),
  /** Whether the result came from a sponsored/marketing slot. */
  sponsored: z.boolean().default(false),
  attributes: z.record(z.unknown()).default({}),
  categories: z.array(CategoryInputSchema).default([]),
  images: z.array(ImageInputSchema).default([]),
  price: PriceInputSchema,
  /** Raw per-variant records; each is validated independently (see validateVariants
   * in variants.ts) so one malformed entry never rejects the parent or its siblings. */
  variants: z.array(z.unknown()).default([]),
  /** True only when this snapshot is known to contain the COMPLETE variant set
   * (validated detail/SSR payload). List pages, JSON-LD fallback, and incomplete
   * detail payloads MUST leave this false. */
  variantsObserved: z.boolean().default(false),
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
  rejected: z.array(z.object({ reason: z.string(), sample: z.unknown().optional() })).default([]),
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

/** Structured request parameters for `scrap-ingest run`; shared by CLI parsing
 * and any future programmatic caller so semantics never drift. */
export const ScraperRunParamsSchema = z.object({
  scraperId: z.string().min(1),
  search: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  pages: PagesSchema.optional(),
  maxRequests: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  downloadImages: z.boolean().default(true),
});
export type ScraperRunParams = z.infer<typeof ScraperRunParamsSchema>;

/** Terminal + in-flight status of one ingestion run (no queue statuses remain). */
export const RunStatusSchema = z.enum(["running", "completed", "partial", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Malformed/duplicate variant diagnostics returned alongside a saved snapshot. */
export const VariantWarningSchema = z.object({
  externalId: z.string().optional(),
  reason: z.string(),
});
export type VariantWarning = z.infer<typeof VariantWarningSchema>;

export { StoreIdSchema, CurrencySchema };
export type { StoreId } from "./ids.ts";
export type { Currency } from "./ids.ts";
