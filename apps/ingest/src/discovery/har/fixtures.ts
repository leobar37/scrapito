/**
 * Candidate fixture extractor. Given a discovery run dir that already went
 * through `discover sanitize` + `discover analyze`, pulls one endpoint
 * candidate out into a review package:
 *
 *   <slug>.response.json        sanitized sample body (fixture seed)
 *   <slug>.descriptor.json      machine-readable endpoint contract
 *   <slug>.adapter-candidate.ts reviewable draft (never executed)
 *
 * Everything written here derives from sanitized evidence; the extractor
 * refuses to run when the descriptor would point at an unsanitized HAR.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScrapError } from "@scrapito/contracts";
import { sha256Hex } from "../artifacts.ts";
import type { CandidatesFile, EndpointCandidate } from "./analyze.ts";
import { emitAdapterSkeleton } from "./candidate.ts";

export interface CandidateDescriptor {
  schemaVersion: 1;
  sourceDir: string;
  extractedAt: string;
  sampleSha256: string;
  method: string;
  origin: string;
  pathTemplate: string;
  responseMimeType: string;
  constantParams: Record<string, string>;
  varyingParams: Record<string, string[]>;
  pagination: EndpointCandidate["pagination"];
  confidence: number;
}

export interface ExtractionResult {
  slug: string;
  responsePath: string;
  descriptorPath: string;
  skeletonPath: string;
}

function slugify(candidate: EndpointCandidate): string {
  const path = candidate.pathTemplate
    .replace(/\{n\}/g, "n")
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${candidate.method.toLowerCase()}-${path || "root"}`.slice(0, 80);
}

export function extractCandidateFixture(options: {
  dir: string;
  candidateIndex: number;
  outDir?: string;
}): ExtractionResult {
  const candidatesPath = join(options.dir, "endpoint-candidates.json");
  if (!existsSync(candidatesPath)) {
    throw new ScrapError(
      "CANDIDATES_NOT_FOUND",
      `no endpoint-candidates.json in ${options.dir}; run \`discover analyze\` first`,
    );
  }
  const file = JSON.parse(readFileSync(candidatesPath, "utf8")) as CandidatesFile;
  const candidate = file.candidates[options.candidateIndex];
  if (!candidate) {
    throw new ScrapError(
      "CANDIDATE_NOT_FOUND",
      `candidate index ${options.candidateIndex} out of range (${file.candidates.length} candidates)`,
    );
  }
  if (!candidate.sampleArtifact) {
    throw new ScrapError("CANDIDATE_NO_SAMPLE", "candidate has no captured sample body");
  }
  const samplePath = join(options.dir, candidate.sampleArtifact);
  if (!existsSync(samplePath)) {
    throw new ScrapError("CANDIDATE_SAMPLE_MISSING", `sample artifact missing: ${samplePath}`);
  }
  const body = readFileSync(samplePath, "utf8");

  const slug = slugify(candidate);
  const outDir = options.outDir ?? join(options.dir, "candidates");
  mkdirSync(outDir, { recursive: true });

  const responsePath = join(outDir, `${slug}.response.json`);
  writeFileSync(responsePath, body);

  const descriptor: CandidateDescriptor = {
    schemaVersion: 1,
    sourceDir: options.dir,
    extractedAt: new Date().toISOString(),
    sampleSha256: sha256Hex(body),
    method: candidate.method,
    origin: candidate.origin,
    pathTemplate: candidate.pathTemplate,
    responseMimeType: candidate.responseMimeType,
    constantParams: candidate.constantParams,
    varyingParams: candidate.varyingParams,
    pagination: candidate.pagination,
    confidence: candidate.confidence,
  };
  const descriptorPath = join(outDir, `${slug}.descriptor.json`);
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));

  const skeletonPath = join(outDir, `${slug}.adapter-candidate.ts`);
  writeFileSync(skeletonPath, emitAdapterSkeleton(candidate));

  return { slug, responsePath, descriptorPath, skeletonPath };
}
