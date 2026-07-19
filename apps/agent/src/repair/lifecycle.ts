import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Composition } from "../types.ts";
import { AgentRuntimeError } from "../errors.ts";
import type {
  RepairAuditEvent,
  RepairCandidate,
  RepairChange,
  RepairDiff,
  RepairHashBundle,
  RepairLifecycleHost,
  RepairPlanner,
  RepairState,
} from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const REPAIRABLE_FAILURES: Record<string, true> = { parser: true, normalization: true, fixture: true };
const ALLOWED_SOURCE_NAMES: Record<string, true> = { "products.ts": true, "normalize.ts": true };

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizedJson(entry)]),
    );
  }
  return value;
}

export function hashRepairValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizedJson(value))).digest("hex");
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new AgentRuntimeError("REPAIR_HASH_MISMATCH", `${label} is not a sha256`);
}

export function assertRepairChangeScope(repairRoot: string, changes: readonly RepairChange[]): void {
  if (changes.length === 0 || changes.length > 32) {
    throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", "repair must contain between 1 and 32 changes");
  }
  const root = posix.normalize(repairRoot);
  if (root !== repairRoot || root.startsWith("/") || root.includes("..") || root.includes("\\")) {
    throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", "SiteDefinition repair root is invalid");
  }
  const seen = new Set<string>();
  for (const change of changes) {
    const normalized = posix.normalize(change.path);
    if (
      normalized !== change.path ||
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      !normalized.startsWith(`${root}/`) ||
      change.content.length > 512_000 ||
      seen.has(normalized)
    ) {
      throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", `change is outside the exact repair scope: ${change.path}`);
    }
    seen.add(normalized);
    const relative = normalized.slice(root.length + 1);
    const fixture = relative.startsWith("__fixtures__/") && /\.(?:html|json)$/.test(relative);
    const test = relative.endsWith(".test.ts");
    if (!(fixture || test || ALLOWED_SOURCE_NAMES[relative])) {
      throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", `file type is not repair-allowlisted: ${change.path}`);
    }
  }
}

function candidatePayload(candidate: RepairCandidate): Omit<RepairCandidate, "candidateId" | "hashes" | "audit"> & {
  hashes: Omit<RepairHashBundle, "candidateSha256">;
} {
  const { candidateId: _candidateId, audit: _audit, hashes, ...rest } = candidate;
  const { candidateSha256: _candidateSha256, ...boundHashes } = hashes;
  return { ...rest, hashes: boundHashes };
}

export function assertCandidateIntegrity(candidate: RepairCandidate): void {
  assertRepairChangeScope(candidate.repairRoot, candidate.changes);
  for (const [name, value] of Object.entries(candidate.hashes)) assertSha256(value, name);
  const changedFiles = candidate.changes.map((change) => change.path).sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify([...candidate.changedFiles].sort())) {
    throw new AgentRuntimeError("REPAIR_HASH_MISMATCH", "candidate changed-file list does not match its changes");
  }
  if (hashRepairValue(candidate.changes) !== candidate.hashes.changesSha256) {
    throw new AgentRuntimeError("REPAIR_HASH_MISMATCH", "candidate changes hash mismatch");
  }
  const candidateSha256 = hashRepairValue(candidatePayload(candidate));
  if (candidateSha256 !== candidate.hashes.candidateSha256 || candidate.candidateId !== candidateSha256.slice(0, 32)) {
    throw new AgentRuntimeError("REPAIR_HASH_MISMATCH", "candidate content hash mismatch");
  }
}

function appendAudit(audit: RepairAuditEvent[], state: RepairState, detail: string, hashRefs: Record<string, string> = {}): void {
  audit.push({ sequence: audit.length + 1, state, detail, hashRefs: { ...hashRefs } });
}

function assertDiff(diff: RepairDiff, changes: readonly RepairChange[]): void {
  if (hashRepairValue(diff.text) !== diff.sha256) {
    throw new AgentRuntimeError("REPAIR_HASH_MISMATCH", "worktree diff hash mismatch");
  }
  const expected = changes.map((change) => change.path).sort();
  if (JSON.stringify([...diff.files].sort()) !== JSON.stringify(expected)) {
    throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", "worktree diff includes files outside the proposed change set");
  }
  assertSha256(diff.fixturesSha256, "fixturesSha256");
}

export async function runRepairLifecycle(input: {
  composition: Composition;
  host: RepairLifecycleHost;
  planner: RepairPlanner;
}): Promise<RepairCandidate> {
  const { composition, host, planner } = input;
  const { invocation, site } = composition;
  const reproduction = invocation.repairPolicy.reproduction;
  if (invocation.intent !== "repair" || !invocation.repairPolicy.allowRepair || !reproduction) {
    throw new AgentRuntimeError("REPAIR_NOT_AUTHORIZED", "repair requires an explicit authorized repair Invocation");
  }
  if (!composition.evidence.includes(reproduction.evidenceId)) {
    throw new AgentRuntimeError("UNAPPROVED_EVIDENCE", "reproduction evidence is outside the static capability cell");
  }

  const repairRoot = site.repairRoots[0];
  if (!repairRoot || site.repairRoots.length !== 1) {
    throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", "repair requires one exact SiteDefinition repair root");
  }
  const audit: RepairAuditEvent[] = [];
  appendAudit(audit, "requested", "explicit repair Invocation accepted");
  appendAudit(audit, "classified", "failure is eligible only after exact offline reproduction");
  const workspace = await host.createWorktree({
    invocationId: invocation.invocationId,
    site,
    expectedCommit: reproduction.baselineCommit,
    expectedTreeSha256: reproduction.baselineTreeSha256,
  });
  if (workspace.baseCommit !== reproduction.baselineCommit || workspace.baselineTreeSha256 !== reproduction.baselineTreeSha256) {
    throw new AgentRuntimeError("REPAIR_BASELINE_MISMATCH", "isolated worktree baseline does not match the Invocation");
  }

  const sourceFiles = await host.readAllowedSources(workspace, repairRoot);
  const evidencePath = `apps/ingest/src/scrapers/${reproduction.evidenceId}`;
  const evidence = sourceFiles.find((file) => file.path === evidencePath);
  if (!evidence || evidence.sha256 !== reproduction.evidenceSha256) {
    throw new AgentRuntimeError("REPAIR_HASH_MISMATCH", "checked-in evidence hash does not match the Invocation");
  }
  const reproduced = await host.reproduce(workspace, site.scraperId);
  if (reproduced.ok || !REPAIRABLE_FAILURES[reproduced.kind] || reproduced.sha256 !== reproduction.expectedFailureSha256) {
    throw new AgentRuntimeError("REPAIR_NOT_REPRODUCIBLE", "failure did not reproduce exactly or is not repair-eligible");
  }
  appendAudit(audit, "reproduced", "offline failure reproduced exactly", { reproduction: reproduced.sha256 });
  appendAudit(audit, "candidate_created", "bounded repair proposal requested");

  const changes = [...await planner.propose({ invocation, site, workspace, sourceFiles, reproduction: reproduced })];
  assertRepairChangeScope(repairRoot, changes);
  await host.applyChanges(workspace, changes);
  appendAudit(audit, "patched_in_worktree", "host applied allowlisted changes only in isolated worktree");

  const diff = await host.diff(workspace);
  assertDiff(diff, changes);
  const checks = await host.verifyOffline(workspace, site.scraperId);
  if (!checks.ok) throw new AgentRuntimeError("REPAIR_OFFLINE_CHECK_FAILED", checks.detail);
  appendAudit(audit, "offline_verified", "fixed offline validation passed", { checks: checks.sha256 });
  const canary = await host.canary(workspace, site.scraperId);
  if (!canary.ok) throw new AgentRuntimeError("REPAIR_CANARY_FAILED", canary.detail);
  appendAudit(audit, "worktree_canary_passed", "temporary worktree canary passed", { canary: canary.sha256 });

  const independentDiff = await host.diff(workspace);
  const independentChecks = await host.verifyOffline(workspace, site.scraperId);
  const independentCanary = await host.canary(workspace, site.scraperId);
  assertDiff(independentDiff, changes);
  if (
    independentDiff.sha256 !== diff.sha256 ||
    !independentChecks.ok || independentChecks.sha256 !== checks.sha256 ||
    !independentCanary.ok || independentCanary.sha256 !== canary.sha256
  ) {
    throw new AgentRuntimeError("REPAIR_INDEPENDENT_VERIFICATION_FAILED", "independent verifier observed hash/check/canary drift");
  }
  appendAudit(audit, "independently_verified", "read-only independent verification matched all candidate evidence");
  appendAudit(audit, "awaiting_approval", "human approval required; auto-promotion is disabled");

  const states = audit.map((event) => event.state);
  const hashesWithoutCandidate = {
    baselineCommitSha256: hashRepairValue(workspace.baseCommit),
    baselineTreeSha256: workspace.baselineTreeSha256,
    reproductionSha256: reproduced.sha256,
    evidenceSha256: reproduction.evidenceSha256,
    runSha256: reproduction.runSha256,
    changesSha256: hashRepairValue(changes),
    diffSha256: diff.sha256,
    fixturesSha256: diff.fixturesSha256,
    checksSha256: checks.sha256,
    canarySha256: canary.sha256,
  };
  const draft = {
    version: 1 as const,
    candidateId: "",
    invocationId: invocation.invocationId,
    site: invocation.site,
    strategy: invocation.strategy,
    repairRoot,
    workspace,
    evidenceId: reproduction.evidenceId,
    runRef: reproduction.runRef,
    changes,
    changedFiles: changes.map((change) => change.path).sort(),
    checks,
    canary,
    states,
    hashes: { ...hashesWithoutCandidate, candidateSha256: "" },
    audit,
  } satisfies RepairCandidate;
  const candidateSha256 = hashRepairValue(candidatePayload(draft));
  const candidate: RepairCandidate = {
    ...draft,
    candidateId: candidateSha256.slice(0, 32),
    hashes: { ...hashesWithoutCandidate, candidateSha256 },
  };
  assertCandidateIntegrity(candidate);
  return candidate;
}
