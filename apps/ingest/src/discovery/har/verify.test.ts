import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsDiscoveryArtifacts, sha256Hex } from "../artifacts.ts";
import { analyzeHar, type CandidatesFile } from "./analyze.ts";
import { parseHar, type HarFile } from "./har-schema.ts";
import { REDACTED } from "./sanitize.ts";
import { verifyDiscoveryDir, type VerificationCheck, type VerificationReport } from "./verify.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const PRODUCT_BODY = JSON.stringify({ products: [{ sku: "TV-1", price: 1299 }] });

function sanitizedHar(cookieValue: string): HarFile {
  return parseHar({
    log: {
      version: "1.2",
      entries: [1, 2].map((page) => ({
        request: {
          method: "GET",
          url: `https://www.promart.pe/api/search?q=tv&page=${page}`,
          headers: [{ name: "cookie", value: cookieValue }],
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

/** A complete, internally consistent discovery run dir, built with the real
 * artifact store so the manifest hashes genuinely match the files on disk. */
function seedRunDir(options?: { cookieValue?: string; skipCandidates?: boolean }): string {
  const base = mkdtempSync(join(tmpdir(), "discovery-verify-"));
  tmpDirs.push(base);
  const artifacts = new FsDiscoveryArtifacts(base, "run-1");
  artifacts.save("home.html", "<html></html>");
  const har = sanitizedHar(options?.cookieValue ?? REDACTED);
  artifacts.save("network.sanitized.har", JSON.stringify(har));
  if (!options?.skipCandidates) {
    const result = analyzeHar(har);
    for (const sample of result.samples) artifacts.save(sample.name, sample.body);
    const candidatesFile: CandidatesFile = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceHar: "network.sanitized.har",
      stats: result.stats,
      candidates: result.candidates,
    };
    artifacts.saveJson("endpoint-candidates.json", candidatesFile);
  }
  artifacts.writeManifest({
    scraperId: "promart-pe",
    store: "promart-pe",
    startedAt: "2026-07-19T00:00:00.000Z",
    userAgent: "scrapito-test (+https://example.com/bot)",
    scenarios: ["home"],
    harAvailable: true,
  });
  return artifacts.dir;
}

/** Re-hash every artifact after a deliberate edit so ONLY the derived-data
 * checks (not integrity) can fail — isolates the check under test. */
function refreezeManifest(dir: string): void {
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.artifacts = manifest.artifacts
    .filter((a: { name: string }) => a.name !== "manifest.json")
    .map((a: { name: string }) => ({
      ...a,
      sha256: sha256Hex(new Uint8Array(readFileSync(join(dir, a.name)))),
    }));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function check(report: { checks: VerificationCheck[] }, name: string): VerificationCheck {
  const found = report.checks.find((c) => c.name === name);
  expect(found, `check ${name} should exist`).toBeDefined();
  return found!;
}

describe("verifyDiscoveryDir — integrity", () => {
  test("a consistent run dir verifies ok across manifest, artifacts and analysis", () => {
    const dir = seedRunDir();

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(true);
    for (const c of report.checks) expect(c.ok, `check ${c.name}: ${c.detail}`).toBe(true);
    // The report actually covers both guarantee families, not just one.
    check(report, "manifest:present");
    check(report, "artifact:home.html");
    check(report, "artifact:network.sanitized.har");
    check(report, "sanitized-har:no-live-secrets");
    check(report, "analysis:reproducible");
    check(report, "pagination:/api/search");
  });

  test("a tampered artifact fails its sha256 check", () => {
    const dir = seedRunDir();
    writeFileSync(join(dir, "home.html"), "<html>tampered</html>");

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(false);
    const c = check(report, "artifact:home.html");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("sha256 mismatch");
  });

  test("a missing artifact is reported as missing", () => {
    const dir = seedRunDir();
    rmSync(join(dir, "home.html"));

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(false);
    expect(check(report, "artifact:home.html")).toMatchObject({ ok: false, detail: "file missing" });
  });

  test("a dir without manifest.json cannot verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "discovery-verify-"));
    tmpDirs.push(dir);

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(false);
    expect(check(report, "manifest:present")).toMatchObject({ ok: false });
  });
});

describe("verifyDiscoveryDir — analysis guarantees", () => {
  test("regression: live secret + candidates file fails checks instead of crashing the verifier", () => {
    // Previously verifyAnalysis re-ran analyzeHar uncaught: a sanitized HAR
    // with a live sensitive header plus a well-formed candidates file made
    // verifyDiscoveryDir THROW HAR_NOT_SANITIZED instead of reporting.
    const base = mkdtempSync(join(tmpdir(), "discovery-verify-"));
    tmpDirs.push(base);
    const artifacts = new FsDiscoveryArtifacts(base, "run-1");
    artifacts.save("network.sanitized.har", JSON.stringify(sanitizedHar("sessionid=live")));
    // Candidates file is well-formed: derived from a sanitized twin of the same HAR.
    const cleanResult = analyzeHar(sanitizedHar(REDACTED));
    artifacts.saveJson("endpoint-candidates.json", {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceHar: "network.sanitized.har",
      stats: cleanResult.stats,
      candidates: cleanResult.candidates,
    } satisfies CandidatesFile);
    artifacts.writeManifest({
      scraperId: "promart-pe",
      store: "promart-pe",
      startedAt: "2026-07-19T00:00:00.000Z",
      userAgent: "scrapito-test (+https://example.com/bot)",
      scenarios: ["home"],
      harAvailable: true,
    });

    let report: VerificationReport | undefined;
    expect(() => {
      report = verifyDiscoveryDir(artifacts.dir);
    }).not.toThrow();

    expect(report!.ok).toBe(false);
    expect(check(report!, "sanitized-har:no-live-secrets").ok).toBe(false);
    const c = check(report!, "analysis:reproducible");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("re-analysis aborted");
  });

  test("a live sensitive header in the sanitized HAR fails the no-live-secrets check", () => {
    const dir = seedRunDir({ cookieValue: "sessionid=live", skipCandidates: true });

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(false);
    const c = check(report, "sanitized-har:no-live-secrets");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("cookie");
  });

  test("a candidates file that no longer matches re-analysis is flagged stale", () => {
    const dir = seedRunDir();
    const candidatesPath = join(dir, "endpoint-candidates.json");
    const candidatesFile = JSON.parse(readFileSync(candidatesPath, "utf8")) as CandidatesFile;
    candidatesFile.candidates[0]!.pathTemplate = "/api/search/v2";
    writeFileSync(candidatesPath, JSON.stringify(candidatesFile, null, 2));
    refreezeManifest(dir);

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(false);
    const c = check(report, "analysis:reproducible");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("stale or tampered");
  });

  test("a pagination hypothesis without ≥2 observed values fails its check (reproducibility intact)", () => {
    const dir = seedRunDir();
    const candidatesPath = join(dir, "endpoint-candidates.json");
    const candidatesFile = JSON.parse(readFileSync(candidatesPath, "utf8")) as CandidatesFile;
    candidatesFile.candidates[0]!.varyingParams = { page: ["1"] }; // hypothesis kept, only one observed value
    writeFileSync(candidatesPath, JSON.stringify(candidatesFile, null, 2));
    refreezeManifest(dir);

    const report = verifyDiscoveryDir(dir);

    expect(report.ok).toBe(false);
    expect(check(report, "analysis:reproducible").ok).toBe(true);
    const c = check(report, "pagination:/api/search");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("page");
  });
});
