import { z } from "zod";
import { StoreIdSchema } from "./ids.ts";
import {
  CategoryTargetSchema,
  HomepageTargetSchema,
  ProductTargetSchema,
  TrendingTargetSchema,
} from "./observations.ts";
import { PagesSchema, RunStatusSchema } from "./schemas.ts";

export const INVOCATION_SCHEMA_VERSION = 1 as const;

export const SearchTargetSchema = z
  .object({ kind: z.literal("search"), query: z.string().trim().min(1).max(500) })
  .strict();

/** One-shot invocation targets. Search is intentionally invocation-only: it is
 * non-authoritative discovery and is not persisted as a P-002 target identity. */
export const InvocationTargetSchema = z.union([
  HomepageTargetSchema,
  TrendingTargetSchema,
  CategoryTargetSchema,
  ProductTargetSchema,
  SearchTargetSchema,
]);
export type InvocationTarget = z.infer<typeof InvocationTargetSchema>;

export const StrategyIdSchema = z.enum(["homepage", "trending", "category", "product", "search"]);
export type StrategyId = z.infer<typeof StrategyIdSchema>;

export const CapabilityIdSchema = z.enum(["inspect", "acquire", "repair", "verify"]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const InvocationConstraintsSchema = z
  .object({
    maxRequests: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    pages: PagesSchema.optional(),
    downloadImages: z.boolean().optional(),
  })
  .strict()
  .superRefine((constraints, ctx) => {
    const pages = constraints.pages;
    if (pages && typeof pages === "object" && !Array.isArray(pages) && pages.from > pages.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pages"], message: "page range must have from <= to" });
    }
    const pageCount =
      pages == null
        ? 1
        : typeof pages === "number"
          ? 1
          : Array.isArray(pages)
            ? pages.length
            : pages.to - pages.from + 1;
    if (pageCount > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pages"], message: "at most 100 pages may be requested" });
    }
  });
export type InvocationConstraints = z.infer<typeof InvocationConstraintsSchema>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const OpaqueRepairRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/);

export const RepairReproductionSchema = z
  .object({
    runRef: OpaqueRepairRefSchema,
    runSha256: Sha256Schema,
    evidenceId: z.string().trim().min(1).max(300),
    evidenceSha256: Sha256Schema,
    expectedFailureSha256: Sha256Schema,
    baselineCommit: GitObjectIdSchema,
    baselineTreeSha256: Sha256Schema,
  })
  .strict();
export type RepairReproduction = z.infer<typeof RepairReproductionSchema>;

export const RepairPolicySchema = z
  .object({
    allowRepair: z.boolean().default(false),
    reproduction: RepairReproductionSchema.optional(),
  })
  .strict();
export type RepairPolicy = z.infer<typeof RepairPolicySchema>;

export const InvocationContextSchema = z
  .object({
    schemaVersion: z.literal(INVOCATION_SCHEMA_VERSION),
    invocationId: z.string().trim().min(1).max(200),
    intent: CapabilityIdSchema,
    site: StoreIdSchema,
    strategy: StrategyIdSchema,
    target: InvocationTargetSchema,
    constraints: InvocationConstraintsSchema.default({}),
    repairPolicy: RepairPolicySchema.default({ allowRepair: false }),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.strategy !== input.target.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "kind"],
        message: `target kind ${input.target.kind} does not match strategy ${input.strategy}`,
      });
    }
    if (
      input.target.kind === "category" &&
      (input.target.externalId.startsWith("/") ||
        input.target.externalId.includes("://") ||
        /[?#\\]/.test(input.target.externalId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "externalId"],
        message: "category externalId must be a relative store category path without query, hash, or backslash",
      });
    }
    if (input.target.kind === "product" && "canonicalUrl" in input.target) {
      const expectedHost = {
        "ripley-pe": "simple.ripley.com.pe",
        "falabella-pe": "www.falabella.com.pe",
        "promart-pe": "www.promart.pe",
        "oechsle-pe": "www.oechsle.pe",
      }[input.site];
      if (new URL(input.target.canonicalUrl).hostname !== expectedHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target", "canonicalUrl"],
          message: `product canonicalUrl host does not match site ${input.site}`,
        });
      }
    }
    if (input.intent !== "repair" && input.repairPolicy.allowRepair) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repairPolicy", "allowRepair"],
        message: "allowRepair is only valid for an explicit repair invocation",
      });
    }
    if (input.intent !== "repair" && input.repairPolicy.reproduction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repairPolicy", "reproduction"],
        message: "reproduction is only valid for an explicit repair invocation",
      });
    }
    if (input.intent === "repair" && (!input.repairPolicy.allowRepair || !input.repairPolicy.reproduction)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repairPolicy"],
        message: "explicit repair requires allowRepair=true and reproducible hash-bound evidence",
      });
    }
  });
export type InvocationContext = z.infer<typeof InvocationContextSchema>;

export const CanonicalizationDefinitionSchema = z
  .object({
    protocol: z.literal("https:"),
    host: z.string().min(1),
    stripHash: z.literal(true),
  })
  .strict();

export const SiteDefinitionSchema = z
  .object({
    site: StoreIdSchema,
    scraperId: z.string().min(1),
    hosts: z.array(z.string().min(1)).min(1),
    canonicalization: CanonicalizationDefinitionSchema,
    repairRoots: z.array(z.string().min(1)).min(1),
    contextRefs: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type SiteDefinition = z.infer<typeof SiteDefinitionSchema>;

export const CoverageSemanticsSchema = z
  .object({
    createsCoverage: z.boolean(),
    authoritativeEligible: z.boolean(),
    membershipEvidence: z.enum(["none", "non_authoritative", "complete_boundary"]),
    boundary: z.enum(["none", "requested_pages", "product_identity"]),
  })
  .strict();

export const StrategyDefinitionSchema = z
  .object({
    strategy: StrategyIdSchema,
    targetKind: StrategyIdSchema,
    coverage: CoverageSemanticsSchema,
    contextRef: z.string().min(1),
  })
  .strict();
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;

export const CapabilityDefinitionSchema = z
  .object({
    capability: CapabilityIdSchema,
    sideEffect: z.enum(["none", "catalog_write", "worktree_write"]),
    output: z.enum(["inspection", "acquisition", "repair", "verification"]),
    contextRef: z.string().min(1),
  })
  .strict();
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

const SupportedCapabilityCellSchema = z
  .object({
    site: StoreIdSchema,
    strategy: StrategyIdSchema,
    capability: CapabilityIdSchema,
    supported: z.literal(true),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();
const UnsupportedCapabilityCellSchema = z
  .object({
    site: StoreIdSchema,
    strategy: StrategyIdSchema,
    capability: CapabilityIdSchema,
    supported: z.literal(false),
    reason: z.string().min(1),
  })
  .strict();
export const CapabilitySupportCellSchema = z.discriminatedUnion("supported", [
  SupportedCapabilityCellSchema,
  UnsupportedCapabilityCellSchema,
]);
export type CapabilitySupportCell = z.infer<typeof CapabilitySupportCellSchema>;

export const InvocationArtifactSchema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  })
  .strict();

export const InvocationRunSchema = z
  .object({
    runId: z.number().int().positive(),
    scraperId: z.string().min(1),
    status: RunStatusSchema.exclude(["running"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();

export const InvocationCoverageSchema = z
  .object({
    coverageId: z.number().int().positive(),
    status: z.enum(["complete", "partial", "failed"]),
    authoritative: z.boolean(),
    boundary: z.record(z.unknown()).nullable(),
    requests: z.number().int().nonnegative(),
    productsSeen: z.number().int().nonnegative(),
    duplicatesSeen: z.number().int().nonnegative(),
    productsRejected: z.number().int().nonnegative(),
    stopReason: z.enum([
      "completed",
      "budget_exhausted",
      "challenge",
      "circuit_open",
      "error",
      "cancelled",
      "ingest_restarted",
    ]),
  })
  .strict();

export const InvocationUsageSchema = z
  .object({
    requests: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    writerDurationMs: z.number().int().nonnegative(),
    productsSaved: z.number().int().nonnegative(),
    /** Distinct products represented by this Invocation's coverage. */
    productsSeen: z.number().int().nonnegative(),
    productsRejected: z.number().int().nonnegative(),
    duplicatesSeen: z.number().int().nonnegative(),
    imagesDownloaded: z.number().int().nonnegative(),
    llm: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const InvocationErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();

export const InvocationResultSchema = z
  .object({
    schemaVersion: z.literal(INVOCATION_SCHEMA_VERSION),
    invocationId: z.string().min(1),
    status: z.enum(["completed", "partial", "failed", "rejected"]),
    site: StoreIdSchema,
    strategy: StrategyIdSchema,
    capability: CapabilityIdSchema,
    run: InvocationRunSchema.nullable(),
    coverage: InvocationCoverageSchema.nullable(),
    artifacts: z.array(InvocationArtifactSchema),
    usage: InvocationUsageSchema,
    error: InvocationErrorSchema.nullable(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if ((result.status === "failed" || result.status === "rejected") && result.error == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "failed/rejected results require an error" });
    }
    if ((result.status === "completed" || result.status === "partial") && result.error != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "successful/partial results cannot include an error" });
    }
  });
export type InvocationResult = z.infer<typeof InvocationResultSchema>;
