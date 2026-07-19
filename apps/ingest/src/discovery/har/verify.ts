/**
 * Offline verification of a discovery run dir. Two independent guarantees:
 *
 *  1. Integrity — every artifact listed in manifest.json still exists and its
 *     SHA-256 matches, so review decisions bind to untampered evidence.
 *  2. Reproducibility & hypotheses — if a sanitized HAR and candidates file
 *     exist, the analysis is re-run and must reproduce the same endpoint set,
 *     every pagination hypothesis must be backed by ≥2 distinct observed
 *     values, and no sensitive header may survive with a live value.
 *
 * Pure filesystem reads; no network, no browser, no DB.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../artifacts.ts";
import { analyzeHar, type AnalysisResult, type CandidatesFile } from "./analyze.ts";
import { parseHar } from "./har-schema.ts";
import { headerNameIsSensitive, REDACTED } from "./sanitize.ts";

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  dir: string;
  checks: VerificationCheck[];
}

interface ManifestFile {
  schemaVersion: number;
  harAvailable: boolean;
  artifacts: { name: string; sha256: string; bytes: number; savedAt: string }[];
}

function verifyManifest(dir: string, checks: VerificationCheck[]): void {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    checks.push({ name: "manifest:present", ok: false, detail: "manifest.json missing" });
    return;
  }
  checks.push({ name: "manifest:present", ok: true });
  let manifest: ManifestFile;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestFile;
  } catch (err) {
    checks.push({ name: "manifest:parse", ok: false, detail: String(err) });
    return;
  }
  checks.push({ name: "manifest:parse", ok: true });
  for (const entry of manifest.artifacts ?? []) {
    const path = join(dir, entry.name);
    if (!existsSync(path)) {
      checks.push({ name: `artifact:${entry.name}`, ok: false, detail: "file missing" });
      continue;
    }
    const actual = sha256Hex(new Uint8Array(readFileSync(path)));
    checks.push({
      name: `artifact:${entry.name}`,
      ok: actual === entry.sha256,
      detail: actual === entry.sha256 ? undefined : `sha256 mismatch: expected ${entry.sha256}, got ${actual}`,
    });
  }
}

function verifyAnalysis(dir: string, checks: VerificationCheck[]): void {
  const harPath = join(dir, "network.sanitized.har");
  const candidatesPath = join(dir, "endpoint-candidates.json");
  if (!existsSync(harPath)) return; // nothing derived yet — integrity only run
  let har;
  try {
    har = parseHar(JSON.parse(readFileSync(harPath, "utf8")));
    checks.push({ name: "sanitized-har:parse", ok: true });
  } catch (err) {
    checks.push({ name: "sanitized-har:parse", ok: false, detail: String(err) });
    return;
  }
  const leaked: string[] = [];
  for (const entry of har.log.entries) {
    for (const h of [...entry.request.headers, ...entry.response.headers]) {
      if (headerNameIsSensitive(h.name) && h.value !== REDACTED) leaked.push(h.name);
    }
  }
  const secretsClean = leaked.length === 0;
  checks.push({
    name: "sanitized-har:no-live-secrets",
    ok: secretsClean,
    detail: secretsClean ? undefined : `live sensitive headers: ${[...new Set(leaked)].join(", ")}`,
  });

  if (!existsSync(candidatesPath)) return;
  let candidatesFile: CandidatesFile;
  try {
    candidatesFile = JSON.parse(readFileSync(candidatesPath, "utf8")) as CandidatesFile;
    checks.push({ name: "candidates:parse", ok: true });
  } catch (err) {
    checks.push({ name: "candidates:parse", ok: false, detail: String(err) });
    return;
  }

  // Re-running the analyzer on tampered evidence throws HAR_NOT_SANITIZED;
  // that must surface as a failed check, never crash the verifier.
  let rerun: AnalysisResult;
  try {
    rerun = analyzeHar(har);
  } catch (err) {
    checks.push({
      name: "analysis:reproducible",
      ok: false,
      detail: `re-analysis aborted: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const expectedKeys = candidatesFile.candidates
    .map((c) => `${c.method} ${c.origin}${c.pathTemplate}`)
    .sort();
  const actualKeys = rerun.candidates
    .map((c) => `${c.method} ${c.origin}${c.pathTemplate}`)
    .sort();
  checks.push({
    name: "analysis:reproducible",
    ok: JSON.stringify(expectedKeys) === JSON.stringify(actualKeys),
    detail:
      JSON.stringify(expectedKeys) === JSON.stringify(actualKeys)
        ? undefined
        : "re-analysis yields a different endpoint set; candidates file is stale or tampered",
  });

  for (const c of candidatesFile.candidates) {
    if (!c.pagination) continue;
    const backed = c.pagination.parameters.every((p) => (c.varyingParams[p]?.length ?? 0) >= 2);
    checks.push({
      name: `pagination:${c.pathTemplate}`,
      ok: backed,
      detail: backed
        ? undefined
        : `hypothesis ${c.pagination.kind} lacks ≥2 observed values for ${c.pagination.parameters.join(", ")}`,
    });
  }
}

/** Verify a discovery run dir; `ok` is the conjunction of every check. */
export function verifyDiscoveryDir(dir: string): VerificationReport {
  const checks: VerificationCheck[] = [];
  verifyManifest(dir, checks);
  verifyAnalysis(dir, checks);
  return { ok: checks.every((c) => c.ok), dir, checks };
}
