import type { InvocationContext, SiteDefinition } from "@scrapito/contracts";

export const REPAIR_STATES = [
  "requested",
  "classified",
  "reproduced",
  "candidate_created",
  "patched_in_worktree",
  "offline_verified",
  "worktree_canary_passed",
  "independently_verified",
  "awaiting_approval",
  "approved",
  "promoted",
  "production_canary",
  "healthy",
  "rejected",
  "rolled_back",
  "escalated",
] as const;
export type RepairState = (typeof REPAIR_STATES)[number];

export interface RepairChange {
  path: string;
  content: string;
}

export type RepairCheckKind =
  | "ok"
  | "parser"
  | "normalization"
  | "fixture"
  | "empty"
  | "policy"
  | "challenge"
  | "circuit"
  | "budget"
  | "lease";

export interface RepairCheck {
  ok: boolean;
  kind: RepairCheckKind;
  sha256: string;
  detail: string;
}

export interface RepairWorkspace {
  id: string;
  root: string;
  baseCommit: string;
  baselineTreeSha256: string;
}

export interface RepairDiff {
  text: string;
  files: string[];
  sha256: string;
  fixturesSha256: string;
}

export interface RepairHashBundle {
  baselineCommitSha256: string;
  baselineTreeSha256: string;
  reproductionSha256: string;
  evidenceSha256: string;
  runSha256: string;
  changesSha256: string;
  diffSha256: string;
  fixturesSha256: string;
  checksSha256: string;
  canarySha256: string;
  candidateSha256: string;
}

export interface RepairAuditEvent {
  sequence: number;
  state: RepairState;
  detail: string;
  hashRefs: Record<string, string>;
}

export interface RepairCandidate {
  version: 1;
  candidateId: string;
  invocationId: string;
  site: InvocationContext["site"];
  strategy: InvocationContext["strategy"];
  repairRoot: string;
  workspace: RepairWorkspace;
  evidenceId: string;
  runRef: string;
  changes: RepairChange[];
  changedFiles: string[];
  checks: RepairCheck;
  canary: RepairCheck;
  states: RepairState[];
  hashes: RepairHashBundle;
  audit: RepairAuditEvent[];
}

export interface RepairPlanner {
  propose(input: {
    invocation: InvocationContext;
    site: SiteDefinition;
    workspace: RepairWorkspace;
    sourceFiles: readonly { path: string; content: string; sha256: string }[];
    reproduction: RepairCheck;
  }): Promise<readonly RepairChange[]>;
}

export interface RepairLifecycleHost {
  createWorktree(input: {
    invocationId: string;
    site: SiteDefinition;
    expectedCommit: string;
    expectedTreeSha256: string;
  }): Promise<RepairWorkspace>;
  readAllowedSources(workspace: RepairWorkspace, repairRoot: string): Promise<readonly { path: string; content: string; sha256: string }[]>;
  reproduce(workspace: RepairWorkspace, scraperId: string): Promise<RepairCheck>;
  applyChanges(workspace: RepairWorkspace, changes: readonly RepairChange[]): Promise<void>;
  diff(workspace: RepairWorkspace): Promise<RepairDiff>;
  verifyOffline(workspace: RepairWorkspace, scraperId: string): Promise<RepairCheck>;
  canary(workspace: RepairWorkspace, scraperId: string): Promise<RepairCheck>;
}

export interface RepairApproval {
  version: 1;
  kind: "human";
  approver: string;
  candidateId: string;
  hashes: RepairHashBundle;
  approvalSha256: string;
}

export interface PromotionSnapshot {
  treeSha256: string;
  opaque: unknown;
}

export interface RepairPromotionHost {
  capture(repairRoot: string, changedFiles: readonly string[]): Promise<PromotionSnapshot>;
  apply(changes: readonly RepairChange[]): Promise<void>;
  productionCanary(scraperId: string): Promise<RepairCheck>;
  rollback(snapshot: PromotionSnapshot): Promise<void>;
  currentTreeSha256(repairRoot: string): Promise<string>;
}

export interface RepairPromotionResult {
  status: "healthy" | "rolled_back" | "escalated";
  states: RepairState[];
  audit: RepairAuditEvent[];
  canary: RepairCheck;
  rollbackSha256: string | null;
}
