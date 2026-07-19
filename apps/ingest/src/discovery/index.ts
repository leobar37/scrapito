/**
 * Discovery registry — imported ONLY by the local `scrap discover` command.
 * Keeping it separate from `src/scrapers/registry.ts` ensures discovery-only
 * browser evaluation never reaches the server module graph.
 */
import type { Discovery } from "./define-discovery.ts";
import { ripleyDiscovery } from "./definitions/ripley-pe.ts";
import { falabellaDiscovery } from "./definitions/falabella-pe.ts";
import { promartDiscovery } from "./definitions/promart-pe.ts";

const DISCOVERIES: readonly Discovery[] = [ripleyDiscovery, falabellaDiscovery, promartDiscovery];

export function getDiscovery(scraperId: string): Discovery | undefined {
  return DISCOVERIES.find((d) => d.scraperId === scraperId);
}

export function listDiscoveries(): readonly Discovery[] {
  return DISCOVERIES;
}

export { defineDiscovery } from "./define-discovery.ts";
export type {
  ArtifactManifestEntry,
  Discovery,
  DiscoverySpec,
  DiscoveryContext,
  DiscoveryArtifacts,
  DiscoveryFn,
  DiscoveryManifestMeta,
} from "./define-discovery.ts";
export { FsDiscoveryArtifacts, sha256Hex } from "./artifacts.ts";
export { runDiscoveryCapture } from "./capture.ts";
export type { DiscoveryCaptureOptions, DiscoveryCaptureResult, DiscoveryScenario } from "./capture.ts";
export { parseHar, HarFileSchema } from "./har/har-schema.ts";
export type { HarEntry, HarFile } from "./har/har-schema.ts";
export { sanitizeHar, REDACTED } from "./har/sanitize.ts";
export type { SanitizeStats } from "./har/sanitize.ts";
export { analyzeHar } from "./har/analyze.ts";
export type { AnalysisResult, CandidatesFile, EndpointCandidate, PaginationHypothesis } from "./har/analyze.ts";
export { extractCandidateFixture } from "./har/fixtures.ts";
export type { CandidateDescriptor, ExtractionResult } from "./har/fixtures.ts";
export { emitAdapterSkeleton } from "./har/candidate.ts";
export { verifyDiscoveryDir } from "./har/verify.ts";
export type { VerificationCheck, VerificationReport } from "./har/verify.ts";
