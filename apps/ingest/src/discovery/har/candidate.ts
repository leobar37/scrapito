/**
 * Emits the reviewable adapter skeleton for an endpoint candidate. This is a
 * TEXT ARTIFACT: it is written next to the extracted fixture for a human to
 * review and manually port into a statically registered scraper. It is never
 * imported, executed, or promoted by any code path.
 */
import type { EndpointCandidate } from "./analyze.ts";

export function emitAdapterSkeleton(candidate: EndpointCandidate): string {
  const constEntries = Object.entries(candidate.constantParams)
    .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");
  const paginationParams = candidate.pagination?.parameters ?? [];
  const paginationBlock = candidate.pagination
    ? `  // pagination (${candidate.pagination.kind}): vary ${paginationParams.map((p) => JSON.stringify(p)).join(", ")}`
    : "  // no pagination hypothesis — capture more scenarios before promoting";
  return `/**
 * ADAPTER CANDIDATE — DRAFT FOR HUMAN REVIEW. DO NOT REGISTER OR EXECUTE.
 *
 * Derived offline from sanitized HAR evidence.
 *   endpoint:   ${candidate.method} ${candidate.origin}${candidate.pathTemplate}
 *   confidence: ${candidate.confidence} (${candidate.requestCount} observed requests)
 *   productLikeKeys: ${candidate.productLikeKeys.join(", ") || "none detected"}
 *
 * Promotion path: review → fixture selfCheck → static registry entry → canary.
 * Every request below MUST go through ctx.http.fetch (CrawlPolicy).
 */
import { z } from "zod";
import type { ProductInput } from "@scrapito/contracts";

/** Observed response shape — tighten to the fields the normalizer needs. */
const ResponseSchema = z.object({}).passthrough();

export function buildCandidateUrl(params: { page?: number; query?: string }): string {
  const url = new URL(${JSON.stringify(candidate.origin + candidate.pathTemplate)});
${constEntries ? `  const constants: Record<string, string> = {\n${constEntries}\n  };\n  for (const [k, v] of Object.entries(constants)) url.searchParams.set(k, v);` : ""}
${paginationBlock}
  // TODO(review): map params.page / params.query onto the varying parameters:
  // ${JSON.stringify(Object.keys(candidate.varyingParams))}
  void params;
  return url.toString();
}

export function normalizeCandidate(json: unknown, sourceUrl: string): ProductInput[] {
  const parsed = ResponseSchema.parse(json);
  void parsed;
  void sourceUrl;
  // TODO(review): map the response onto ProductInput (see promart-pe/normalize.ts
  // for a reviewed JSON→ProductInput example).
  throw new Error("adapter candidate is a draft — implement after review");
}
`;
}
