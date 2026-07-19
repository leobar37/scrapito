import { z } from "zod";
import { StoreIdSchema } from "./ids.ts";
import { CanonicalUrlSchema, CentsSchema } from "./schemas.ts";
import { PriceAccessSchema } from "./offers.ts";

export const HomepageTargetSchema = z.object({ kind: z.literal("homepage") }).strict();
export const TrendingTargetSchema = z.object({ kind: z.literal("trending") }).strict();
export const CategoryTargetSchema = z
  .object({ kind: z.literal("category"), externalId: z.string().min(1) })
  .strict();
const ProductByExternalIdTargetSchema = z
  .object({ kind: z.literal("product"), externalId: z.string().min(1) })
  .strict();
const ProductByCanonicalUrlTargetSchema = z
  .object({ kind: z.literal("product"), canonicalUrl: CanonicalUrlSchema })
  .strict();
export const ProductTargetSchema = z.union([
  ProductByExternalIdTargetSchema,
  ProductByCanonicalUrlTargetSchema,
]);

/** Runtime-neutral target identity. It intentionally has no scheduling fields. */
export const TargetIdentityInputSchema = z.union([
  HomepageTargetSchema,
  TrendingTargetSchema,
  CategoryTargetSchema,
  ProductTargetSchema,
]);
export type TargetIdentityInput = z.infer<typeof TargetIdentityInputSchema>;
export type TargetKind = TargetIdentityInput["kind"];

export function targetIdentityKey(target: TargetIdentityInput): string {
  switch (target.kind) {
    case "homepage":
    case "trending":
      return target.kind;
    case "category":
      return `category:external-id:${target.externalId}`;
    case "product":
      return "externalId" in target
        ? `product:external-id:${target.externalId}`
        : `product:canonical-url:${target.canonicalUrl}`;
  }
}

export const TargetIdentitySchema = z.object({
  id: z.number().int().positive(),
  storeId: StoreIdSchema,
  identityKey: z.string().min(1),
  target: TargetIdentityInputSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TargetIdentity = z.infer<typeof TargetIdentitySchema>;

export const CoverageStatusSchema = z.enum(["running", "complete", "partial", "failed"]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;
export const CoverageStopReasonSchema = z.enum([
  "completed",
  "budget_exhausted",
  "challenge",
  "circuit_open",
  "error",
  "cancelled",
  "ingest_restarted",
]);
export type CoverageStopReason = z.infer<typeof CoverageStopReasonSchema>;

export const RunProvenanceSchema = z.object({
  invocationId: z.string().min(1).nullable().default(null),
  strategy: z.string().min(1).nullable().default(null),
  capability: z.string().min(1).nullable().default(null),
  params: z.unknown().nullable().default(null),
  maxRequests: z.number().int().positive().nullable().default(null),
  maxDurationMs: z.number().int().positive().nullable().default(null),
});
export type RunProvenance = z.infer<typeof RunProvenanceSchema>;

export const CoverageStartInputSchema = z.object({
  target: TargetIdentityInputSchema,
  maxRequests: z.number().int().positive().nullable().default(null),
  maxDurationMs: z.number().int().positive().nullable().default(null),
  requestedPages: z.array(z.number().int().positive()).nullable().default(null),
});
export type CoverageStartInput = z.infer<typeof CoverageStartInputSchema>;

export const CoverageFinishInputSchema = z
  .object({
    status: z.enum(["complete", "partial", "failed"]),
    authoritative: z.boolean().default(false),
    stopReason: CoverageStopReasonSchema,
    requestsMade: z.number().int().nonnegative(),
    productsSeen: z.number().int().nonnegative(),
    duplicatesSeen: z.number().int().nonnegative().default(0),
    productsRejected: z.number().int().nonnegative(),
    boundary: z.record(z.unknown()).nullable().default(null),
    /** External policy threshold. Null records evidence without changing
     * membership activity; only complete authoritative coverage may apply it. */
    inactivityMissThreshold: z.number().int().positive().nullable().default(null),
  })
  .superRefine((input, ctx) => {
    if (input.inactivityMissThreshold != null && (input.status !== "complete" || !input.authoritative)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inactivityMissThreshold"],
        message: "inactivity threshold requires complete authoritative coverage",
      });
    }
  });
export type CoverageFinishInput = z.input<typeof CoverageFinishInputSchema>;

export const TargetCoverageSchema = z.object({
  id: z.number().int().positive(),
  runId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  status: CoverageStatusSchema,
  authoritative: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  maxRequests: z.number().int().positive().nullable(),
  maxDurationMs: z.number().int().positive().nullable(),
  requestedPages: z.array(z.number().int().positive()).nullable(),
  requestsMade: z.number().int().nonnegative(),
  productsSeen: z.number().int().nonnegative(),
  duplicatesSeen: z.number().int().nonnegative(),
  productsRejected: z.number().int().nonnegative(),
  stopReason: CoverageStopReasonSchema.nullable(),
  boundary: z.record(z.unknown()).nullable(),
});
export type TargetCoverage = z.infer<typeof TargetCoverageSchema>;

export const ProductSightingSchema = z.object({
  id: z.number().int().positive(),
  coverageId: z.number().int().positive(),
  productId: z.number().int().positive(),
  priceObservationId: z.number().int().positive(),
  seenAt: z.string(),
  sourceHash: z.string().nullable(),
});
export type ProductSighting = z.infer<typeof ProductSightingSchema>;

export const TargetMembershipSchema = z.object({
  targetId: z.number().int().positive(),
  productId: z.number().int().positive(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastSeenCoverageId: z.number().int().positive(),
  consecutiveCompleteMisses: z.number().int().nonnegative(),
  inactiveAt: z.string().nullable(),
  inactivityReason: z.enum(["complete_coverage_miss", "explicit_source_signal"]).nullable(),
});
export type TargetMembership = z.infer<typeof TargetMembershipSchema>;

export const PriceMovementSchema = z.object({
  priceObservationId: z.number().int().positive(),
  productId: z.number().int().positive(),
  observedAt: z.string(),
  regularCents: CentsSchema.nullable(),
  offerCents: CentsSchema.nullable(),
  cardCents: CentsSchema.nullable(),
  sellerId: z.string().nullable(),
  inStock: z.boolean(),
  effectiveCents: CentsSchema.nullable(),
  priceAccess: PriceAccessSchema.nullable(),
  previousPriceObservationId: z.number().int().positive().nullable(),
  previousEffectiveCents: CentsSchema.nullable(),
  previousPriceAccess: PriceAccessSchema.nullable(),
  previousSellerId: z.string().nullable(),
  previousInStock: z.boolean().nullable(),
  priorHistoricalLowCents: CentsSchema.nullable(),
  isPriceDrop: z.boolean(),
  isHistoricalLow: z.boolean(),
  sellerChanged: z.boolean(),
});
export type PriceMovement = z.infer<typeof PriceMovementSchema>;

export const CurrentPriceDropSchema = PriceMovementSchema.extend({
  storeId: StoreIdSchema,
  externalId: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  sellerName: z.string().nullable(),
  canonicalUrl: z.string(),
  lastSightedAt: z.string(),
  coverageId: z.number().int().positive(),
});
export type CurrentPriceDrop = z.infer<typeof CurrentPriceDropSchema>;
