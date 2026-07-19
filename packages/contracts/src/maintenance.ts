import { z } from "zod";

export const RETENTION_SCHEMA_VERSION = 1 as const;
export const RETENTION_MAX_BATCH_SIZE = 10_000 as const;

/** Explicit, caller-owned one-shot compaction request. It intentionally has no
 * cadence, due time, priority, retry, or scheduling fields. */
export const RetentionRequestSchema = z
  .object({
    schemaVersion: z.literal(RETENTION_SCHEMA_VERSION),
    invocationId: z.string().trim().min(1).max(200),
    dryRun: z.boolean().default(false),
    sightingsBefore: z.string().datetime(),
    batchSize: z.number().int().positive().max(RETENTION_MAX_BATCH_SIZE),
  })
  .strict();
export type RetentionRequest = z.infer<typeof RetentionRequestSchema>;

/** Auditable result for exactly one bounded retention transaction. Historical
 * price observations are immutable under this contract. */
export const RetentionResultSchema = z
  .object({
    schemaVersion: z.literal(RETENTION_SCHEMA_VERSION),
    invocationId: z.string().min(1),
    auditId: z.number().int().positive(),
    status: z.literal("completed"),
    dryRun: z.boolean(),
    sightingsBefore: z.string().datetime(),
    batchSize: z.number().int().positive().max(RETENTION_MAX_BATCH_SIZE),
    candidates: z.number().int().nonnegative(),
    sightingsDeleted: z.number().int().nonnegative(),
    priceObservationsDeleted: z.literal(0),
    hasMore: z.boolean(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    replayed: z.boolean(),
  })
  .strict();
export type RetentionResult = z.infer<typeof RetentionResultSchema>;
