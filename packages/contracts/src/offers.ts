import { z } from "zod";
import { CentsSchema } from "./schemas.ts";
import { StoreIdSchema } from "./ids.ts";
import { ScrapError } from "./errors.ts";

export const OfferQualitySchema = z.enum(["verified_discount", "promotional_price"]);
export type OfferQuality = z.infer<typeof OfferQualitySchema>;

export const PriceAccessSchema = z.enum(["public", "card"]);
export type PriceAccess = z.infer<typeof PriceAccessSchema>;

export interface PriceLike {
  regularCents: number | null;
  offerCents: number | null;
  cardCents: number | null;
}

export interface OfferDerivation {
  effectiveCents: number;
  priceAccess: PriceAccess;
  quality: OfferQuality;
  discountCents: number | null;
  discountBps: number | null;
}

/**
 * Canonical offer derivation, shared by SQL views (mirrored in SQL), the API,
 * and unit tests. Public candidate = offerCents ?? regularCents; conditional
 * candidate = cardCents; effective = the lower available candidate (ties
 * prefer public). `verified_discount` requires a positive regularCents strictly
 * greater than the effective price. A row with neither offerCents nor
 * cardCents is not an offer at all (returns null).
 */
export function deriveOffer(price: PriceLike): OfferDerivation | null {
  if (price.offerCents == null && price.cardCents == null) return null;

  const publicCandidate = price.offerCents ?? price.regularCents;
  const cardCandidate = price.cardCents;

  let effectiveCents: number;
  let priceAccess: PriceAccess;
  if (cardCandidate != null && (publicCandidate == null || cardCandidate < publicCandidate)) {
    effectiveCents = cardCandidate;
    priceAccess = "card";
  } else {
    // publicCandidate is guaranteed non-null here: if it were null, cardCandidate
    // would have taken the branch above (since offerCents/cardCents not both null).
    effectiveCents = publicCandidate as number;
    priceAccess = "public";
  }

  let quality: OfferQuality = "promotional_price";
  let discountCents: number | null = null;
  let discountBps: number | null = null;
  if (price.regularCents != null && price.regularCents > 0 && effectiveCents < price.regularCents) {
    quality = "verified_discount";
    discountCents = price.regularCents - effectiveCents;
    discountBps = Math.floor((discountCents * 10_000) / price.regularCents);
  }
  return { effectiveCents, priceAccess, quality, discountCents, discountBps };
}

/** Quote/escape a user search string into a literal (non-operator) FTS5 MATCH
 * expression: every whitespace-delimited term becomes a quoted phrase, so
 * hyphens, `OR`, `*`, `:`, and other FTS5 metacharacters carry no special
 * meaning. Throws BAD_REQUEST for an empty/illegible expression. */
export function toFtsMatchQuery(q: string): string {
  const terms = q
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
  if (terms.length === 0) {
    throw new ScrapError("BAD_REQUEST", "search query must contain at least one term");
  }
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

const MAX_REPEATED_VALUES = 20;
const MAX_Q_CODEPOINTS = 200;
const MAX_BRAND_CODEPOINTS = 100;
const MAX_CURSOR_LENGTH = 2048;

function codepointLength(s: string): number {
  return Array.from(s).length;
}

export const OfferSortSchema = z.enum([
  "relevance",
  "discount_desc",
  "price_asc",
  "price_desc",
  "updated_desc",
]);
export type OfferSort = z.infer<typeof OfferSortSchema>;

const BrandSchema = z
  .string()
  .min(1)
  .refine((s) => codepointLength(s) <= MAX_BRAND_CODEPOINTS, "brand must be at most 100 code points");

export const OfferSearchInputSchema = z
  .object({
    q: z.string().optional(),
    stores: z.array(StoreIdSchema).max(MAX_REPEATED_VALUES).optional(),
    categoryIds: z.array(z.number().int().positive()).max(MAX_REPEATED_VALUES).optional(),
    brands: z.array(BrandSchema).max(MAX_REPEATED_VALUES).optional(),
    quality: z.array(OfferQualitySchema).max(MAX_REPEATED_VALUES).optional(),
    priceAccess: z.array(PriceAccessSchema).max(MAX_REPEATED_VALUES).optional(),
    inStock: z.boolean().default(true),
    minEffectiveCents: CentsSchema.optional(),
    maxEffectiveCents: CentsSchema.optional(),
    minDiscountBps: z.number().int().min(0).max(10_000).optional(),
    sort: OfferSortSchema.optional(),
    cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
    limit: z.number().int().positive().max(100).default(24),
  })
  .superRefine((val, ctx) => {
    if (val.q !== undefined) {
      const trimmed = val.q.trim();
      if (trimmed.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "q must not be empty after trimming", path: ["q"] });
      } else if (codepointLength(trimmed) > MAX_Q_CODEPOINTS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "q must be at most 200 code points", path: ["q"] });
      }
    }
    if (
      val.minEffectiveCents != null &&
      val.maxEffectiveCents != null &&
      val.minEffectiveCents > val.maxEffectiveCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minEffectiveCents must be <= maxEffectiveCents",
        path: ["minEffectiveCents"],
      });
    }
    if (val.sort === "relevance" && (!val.q || val.q.trim().length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "relevance sort requires q", path: ["sort"] });
    }
  })
  .transform((val) => {
    const q = val.q !== undefined ? val.q.trim() : undefined;
    return {
      ...val,
      q,
      sort: val.sort ?? (q ? ("relevance" as const) : ("discount_desc" as const)),
    };
  });
export type OfferSearchInput = z.infer<typeof OfferSearchInputSchema>;

/** Parse repeated URLSearchParams into an OfferSearchInput; identical semantics
 * across Hono, TanStack Router, and the CLI. Throws BAD_REQUEST on failure. */
export function decodeOfferSearchParams(params: URLSearchParams): OfferSearchInput {
  const raw: Record<string, unknown> = {};
  const q = params.get("q");
  if (q !== null) raw.q = q;
  const stores = params.getAll("store");
  if (stores.length) raw.stores = stores;
  const categoryIds = params.getAll("categoryId");
  if (categoryIds.length) raw.categoryIds = categoryIds.map((v) => Number(v));
  const brands = params.getAll("brand");
  if (brands.length) raw.brands = brands;
  const quality = params.getAll("quality");
  if (quality.length) raw.quality = quality;
  const priceAccess = params.getAll("priceAccess");
  if (priceAccess.length) raw.priceAccess = priceAccess;
  const inStock = params.get("inStock");
  if (inStock !== null) raw.inStock = inStock === "true";
  const minEffectiveCents = params.get("minEffectiveCents");
  if (minEffectiveCents !== null) raw.minEffectiveCents = Number(minEffectiveCents);
  const maxEffectiveCents = params.get("maxEffectiveCents");
  if (maxEffectiveCents !== null) raw.maxEffectiveCents = Number(maxEffectiveCents);
  const minDiscountBps = params.get("minDiscountBps");
  if (minDiscountBps !== null) raw.minDiscountBps = Number(minDiscountBps);
  const sort = params.get("sort");
  if (sort !== null) raw.sort = sort;
  const cursor = params.get("cursor");
  if (cursor !== null) raw.cursor = cursor;
  const limit = params.get("limit");
  if (limit !== null) raw.limit = Number(limit);

  const result = OfferSearchInputSchema.safeParse(raw);
  if (!result.success) {
    throw new ScrapError(
      "BAD_REQUEST",
      result.error.issues[0]?.message ?? "invalid offer search params",
      result.error.issues,
    );
  }
  return result.data;
}

/** Inverse of decodeOfferSearchParams; used by the web app to reflect filters
 * into the URL and by the CLI to print an equivalent request URL. */
export function encodeOfferSearchParams(input: OfferSearchInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  for (const s of input.stores ?? []) params.append("store", s);
  for (const c of input.categoryIds ?? []) params.append("categoryId", String(c));
  for (const b of input.brands ?? []) params.append("brand", b);
  for (const q of input.quality ?? []) params.append("quality", q);
  for (const p of input.priceAccess ?? []) params.append("priceAccess", p);
  if (input.inStock === false) params.set("inStock", "false");
  if (input.minEffectiveCents != null) params.set("minEffectiveCents", String(input.minEffectiveCents));
  if (input.maxEffectiveCents != null) params.set("maxEffectiveCents", String(input.maxEffectiveCents));
  if (input.minDiscountBps != null) params.set("minDiscountBps", String(input.minDiscountBps));
  if (input.sort) params.set("sort", input.sort);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  return params;
}

export const OfferSummarySchema = z.object({
  id: z.number().int(),
  storeId: StoreIdSchema,
  externalId: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  sellerName: z.string().nullable(),
  canonicalUrl: z.string(),
  imageUrl: z.string().nullable(),
  currency: z.literal("PEN"),
  regularCents: CentsSchema.nullable(),
  offerCents: CentsSchema.nullable(),
  cardCents: CentsSchema.nullable(),
  effectiveCents: CentsSchema,
  priceAccess: PriceAccessSchema,
  quality: OfferQualitySchema,
  discountCents: z.number().int().nullable(),
  discountBps: z.number().int().nullable(),
  inStock: z.boolean(),
  latestPriceObservedAt: z.string(),
  lastSeenAt: z.string(),
});
export type OfferSummary = z.infer<typeof OfferSummarySchema>;

export const OfferFacetsSchema = z.object({
  stores: z.array(z.object({ value: StoreIdSchema, count: z.number().int() })),
  brands: z.array(z.object({ value: z.string(), count: z.number().int() })),
  categories: z.array(z.object({ value: z.number().int(), label: z.string(), count: z.number().int() })),
  quality: z.array(z.object({ value: OfferQualitySchema, count: z.number().int() })),
  priceAccess: z.array(z.object({ value: PriceAccessSchema, count: z.number().int() })),
});
export type OfferFacets = z.infer<typeof OfferFacetsSchema>;

export const OfferSearchPageSchema = z.object({
  data: z.array(OfferSummarySchema),
  nextCursor: z.string().nullable(),
  facets: OfferFacetsSchema,
});
export type OfferSearchPage = z.infer<typeof OfferSearchPageSchema>;

export const OfferHistoryObservationSchema = z.object({
  observedAt: z.string(),
  regularCents: CentsSchema.nullable(),
  offerCents: CentsSchema.nullable(),
  cardCents: CentsSchema.nullable(),
  publicEffectiveCents: CentsSchema.nullable(),
  cardEffectiveCents: CentsSchema.nullable(),
  quality: OfferQualitySchema.nullable(),
  discountCents: z.number().int().nullable(),
  discountBps: z.number().int().nullable(),
  inStock: z.boolean(),
});
export type OfferHistoryObservation = z.infer<typeof OfferHistoryObservationSchema>;

export const OfferHistorySchema = z.object({
  observations: z.array(OfferHistoryObservationSchema),
  publicHistoricalLowCents: CentsSchema.nullable(),
  cardHistoricalLowCents: CentsSchema.nullable(),
});
export type OfferHistory = z.infer<typeof OfferHistorySchema>;

export const OfferHistoryResponseSchema = z.object({ data: OfferHistorySchema });
export type OfferHistoryResponse = z.infer<typeof OfferHistoryResponseSchema>;

export { MAX_REPEATED_VALUES as OFFER_SEARCH_MAX_REPEATED_VALUES };
