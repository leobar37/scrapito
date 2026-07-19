import { z } from "zod";
import { CurrencySchema, StoreIdSchema } from "./ids.ts";
import { CentsSchema, CanonicalUrlSchema } from "./schemas.ts";
import { CoverageStatusSchema, CoverageStopReasonSchema } from "./observations.ts";
import { PriceAccessSchema } from "./offers.ts";

const NullableCentsSchema = CentsSchema.nullable();

export const EvidenceBackedOfferSchema = z
  .object({
    productId: z.number().int().positive(),
    storeId: StoreIdSchema,
    externalId: z.string().min(1),
    name: z.string().min(1),
    brand: z.string().min(1).nullable(),
    seller: z
      .object({
        id: z.string().min(1).nullable(),
        name: z.string().min(1).nullable(),
      })
      .strict(),
    url: CanonicalUrlSchema,
    currency: CurrencySchema,
    price: z
      .object({
        observationId: z.number().int().positive(),
        observedAt: z.string().min(1),
        regularCents: NullableCentsSchema,
        offerCents: NullableCentsSchema,
        cardCents: NullableCentsSchema,
        effectiveCents: NullableCentsSchema,
        access: PriceAccessSchema.nullable(),
        inStock: z.boolean(),
      })
      .strict(),
    movement: z
      .object({
        previousObservationId: z.number().int().positive().nullable(),
        previousEffectiveCents: NullableCentsSchema,
        previousAccess: PriceAccessSchema.nullable(),
        priorHistoricalLowCents: NullableCentsSchema,
        currentHistoricalLowCents: NullableCentsSchema,
        isPriceDrop: z.boolean(),
        isHistoricalLow: z.boolean(),
        sellerChanged: z.boolean(),
      })
      .strict(),
    evidence: z
      .object({
        sightingId: z.number().int().positive(),
        seenAt: z.string().min(1),
        coverageId: z.number().int().positive(),
        sourceHash: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();
export type EvidenceBackedOffer = z.infer<typeof EvidenceBackedOfferSchema>;

export const CoverageOfferHandoffSchema = z
  .object({
    invocationId: z.string().min(1),
    runId: z.number().int().positive(),
    site: StoreIdSchema,
    coverage: z
      .object({
        coverageId: z.number().int().positive(),
        status: CoverageStatusSchema,
        authoritative: z.boolean(),
        startedAt: z.string().min(1),
        finishedAt: z.string().min(1).nullable(),
        boundary: z.record(z.unknown()).nullable(),
        stopReason: CoverageStopReasonSchema.nullable(),
      })
      .strict(),
    data: z.array(EvidenceBackedOfferSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type CoverageOfferHandoff = z.infer<typeof CoverageOfferHandoffSchema>;

export const CoverageOfferHandoffQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type CoverageOfferHandoffQuery = z.infer<typeof CoverageOfferHandoffQuerySchema>;
