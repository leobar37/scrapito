import { z } from "zod";
import { StoreIdSchema } from "./ids.ts";
import { RunStatusSchema } from "./schemas.ts";

/** Exact stdout payload for `scrap-ingest run --json` on a completed/failed/partial run. */
export const IngestionRunResultSchema = z.object({
  runId: z.number().int(),
  scraperId: z.string(),
  storeId: StoreIdSchema,
  status: z.enum(["completed", "partial", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  productsSaved: z.number().int(),
  productsRejected: z.number().int(),
  imagesDownloaded: z.number().int(),
  requestsMade: z.number().int(),
  error: z.string().nullable(),
});
export type IngestionRunResult = z.infer<typeof IngestionRunResultSchema>;

/** One row of run/audit history exposed read-only via `/updates`. */
export const UpdateRunSummarySchema = z.object({
  runId: z.number().int(),
  scraperId: z.string(),
  storeId: StoreIdSchema,
  status: RunStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  productsSaved: z.number().int(),
  productsRejected: z.number().int(),
  imagesDownloaded: z.number().int(),
  requestsMade: z.number().int(),
  error: z.string().nullable(),
});
export type UpdateRunSummary = z.infer<typeof UpdateRunSummarySchema>;

export const UpdatesPageSchema = z.object({
  data: z.array(UpdateRunSummarySchema),
  nextCursor: z.string().nullable(),
});
export type UpdatesPage = z.infer<typeof UpdatesPageSchema>;

export const StoreFreshnessSchema = z.object({
  storeId: StoreIdSchema,
  lastSuccessfulAt: z.string().nullable(),
  ageSeconds: z.number().nullable(),
  latestRun: UpdateRunSummarySchema.nullable(),
});
export type StoreFreshness = z.infer<typeof StoreFreshnessSchema>;

export const FreshnessResponseSchema = z.object({
  data: z.array(StoreFreshnessSchema),
});
export type FreshnessResponse = z.infer<typeof FreshnessResponseSchema>;
