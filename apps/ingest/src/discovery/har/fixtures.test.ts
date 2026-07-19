import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScrapError } from "@scrapito/contracts";
import { sha256Hex } from "../artifacts.ts";
import { analyzeHar, type CandidatesFile } from "./analyze.ts";
import { emitAdapterSkeleton } from "./candidate.ts";
import { extractCandidateFixture, type CandidateDescriptor } from "./fixtures.ts";
import { parseHar, type HarFile } from "./har-schema.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const PRODUCT_BODY = JSON.stringify({
  products: [{ sku: "TV-1", price: 1299.99, brand: "Acme" }],
});

function seedHar(): HarFile {
  return parseHar({
    log: {
      version: "1.2",
      entries: [1, 2].map((page) => ({
        request: {
          method: "GET",
          url: `https://www.promart.pe/api/search?q=tv&page=${page}`,
          headers: [],
          queryString: [],
        },
        response: {
          status: 200,
          headers: [],
          content: { mimeType: "application/json", text: PRODUCT_BODY },
        },
      })),
    },
  });
}

/** Reproduce exactly what `scrap discover analyze` writes into a run dir. */
function seedRunDir(): { dir: string; candidatesFile: CandidatesFile } {
  const dir = mkdtempSync(join(tmpdir(), "discovery-fixtures-"));
  tmpDirs.push(dir);
  const result = analyzeHar(seedHar());
  mkdirSync(join(dir, "samples"), { recursive: true });
  for (const sample of result.samples) {
    writeFileSync(join(dir, sample.name), sample.body);
  }
  const candidatesFile: CandidatesFile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHar: "network.sanitized.har",
    stats: result.stats,
    candidates: result.candidates,
  };
  writeFileSync(join(dir, "endpoint-candidates.json"), JSON.stringify(candidatesFile, null, 2));
  return { dir, candidatesFile };
}

function expectScrapError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ScrapError);
    expect((err as ScrapError).code).toBe(code);
    return;
  }
  throw new Error(`expected ScrapError ${code}, but nothing was thrown`);
}

describe("extractCandidateFixture", () => {
  test("extracts sample body, descriptor and reviewable draft for a candidate", () => {
    const { dir, candidatesFile } = seedRunDir();
    const candidate = candidatesFile.candidates[0]!;

    const result = extractCandidateFixture({ dir, candidateIndex: 0 });

    // Fixture seed: the exact sanitized sample body.
    expect(readFileSync(result.responsePath, "utf8")).toBe(PRODUCT_BODY);

    // Descriptor: machine-readable contract whose hash binds to the fixture.
    const descriptor = JSON.parse(
      readFileSync(result.descriptorPath, "utf8"),
    ) as CandidateDescriptor;
    expect(descriptor.schemaVersion).toBe(1);
    expect(descriptor.sampleSha256).toBe(sha256Hex(PRODUCT_BODY));
    expect(descriptor.method).toBe("GET");
    expect(descriptor.origin).toBe("https://www.promart.pe");
    expect(descriptor.pathTemplate).toBe(candidate.pathTemplate);
    expect(descriptor.constantParams).toEqual(candidate.constantParams);
    expect(descriptor.varyingParams).toEqual(candidate.varyingParams);
    expect(descriptor.pagination).toEqual(candidate.pagination);

    // Draft skeleton: clearly marked as non-executable review material.
    const skeleton = readFileSync(result.skeletonPath, "utf8");
    expect(skeleton).toContain("DRAFT FOR HUMAN REVIEW");
    expect(skeleton).toContain("GET https://www.promart.pe/api/search");
  });

  test("CANDIDATES_NOT_FOUND when the run dir was never analyzed", () => {
    const dir = mkdtempSync(join(tmpdir(), "discovery-fixtures-"));
    tmpDirs.push(dir);
    expectScrapError(() => extractCandidateFixture({ dir, candidateIndex: 0 }), "CANDIDATES_NOT_FOUND");
  });

  test("CANDIDATE_NOT_FOUND for an out-of-range index", () => {
    const { dir } = seedRunDir();
    expectScrapError(() => extractCandidateFixture({ dir, candidateIndex: 42 }), "CANDIDATE_NOT_FOUND");
  });

  test("CANDIDATE_NO_SAMPLE when the candidate never produced a sample body", () => {
    const { dir, candidatesFile } = seedRunDir();
    candidatesFile.candidates[0]!.sampleArtifact = null;
    writeFileSync(join(dir, "endpoint-candidates.json"), JSON.stringify(candidatesFile));
    expectScrapError(() => extractCandidateFixture({ dir, candidateIndex: 0 }), "CANDIDATE_NO_SAMPLE");
  });

  test("CANDIDATE_SAMPLE_MISSING when the sample artifact was deleted from disk", () => {
    const { dir, candidatesFile } = seedRunDir();
    rmSync(join(dir, candidatesFile.candidates[0]!.sampleArtifact!));
    expectScrapError(
      () => extractCandidateFixture({ dir, candidateIndex: 0 }),
      "CANDIDATE_SAMPLE_MISSING",
    );
  });
});

describe("emitAdapterSkeleton", () => {
  test("the draft names the endpoint and refuses to be registered as-is", () => {
    const candidate = analyzeHar(seedHar()).candidates[0]!;
    const skeleton = emitAdapterSkeleton(candidate);

    expect(skeleton).toContain("DRAFT FOR HUMAN REVIEW");
    expect(skeleton).toContain(candidate.origin + candidate.pathTemplate);
    // A draft must fail loudly if someone executes it anyway.
    expect(skeleton).toContain("adapter candidate is a draft");
  });
});
