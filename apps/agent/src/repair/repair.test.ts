import { describe, expect, test } from "bun:test";
import type { SiteDefinition } from "@scrapito/contracts";
import { composeInvocation } from "../composition.ts";
import { DeterministicIngestExecutor } from "../ingest-subprocess.ts";
import { invokeOneShot } from "../invocation.ts";
import { DeterministicSessionRunner } from "../omp-session.ts";
import { LifecycleRepairInvocationExecutor } from "../capabilities/repair.ts";
import { WriteGate } from "../gates.ts";
import {
  assertCandidateIntegrity,
  assertRepairChangeScope,
  hashRepairValue,
  runRepairLifecycle,
} from "./lifecycle.ts";
import { assertApprovalCurrent, createHumanApproval, promoteApprovedRepair } from "./promotion.ts";
import type {
  PromotionSnapshot,
  RepairCandidate,
  RepairChange,
  RepairCheck,
  RepairDiff,
  RepairLifecycleHost,
  RepairPlanner,
  RepairPromotionHost,
  RepairWorkspace,
} from "./types.ts";

const BASE_COMMIT = "a".repeat(40);
const BASELINE_TREE = hashRepairValue("baseline-tree");
const EVIDENCE = hashRepairValue("checked-in-fixture");
const FAILURE = hashRepairValue("reproducible-parser-failure");
const CHECKS = hashRepairValue("offline-checks");
const CANARY = hashRepairValue("temporary-canary");
const REPAIR_ROOT = "apps/ingest/src/scrapers/ripley-pe";
const EVIDENCE_PATH = `${REPAIR_ROOT}/__fixtures__/list.html`;
const CHANGE: RepairChange = { path: `${REPAIR_ROOT}/normalize.ts`, content: "export const repaired = true;\n" };

function repairManifest() {
  return {
    schemaVersion: 1,
    invocationId: "repair-ripley-001",
    intent: "repair",
    site: "ripley-pe",
    strategy: "category",
    target: { kind: "category", externalId: "electrohogar/refrigeracion" },
    constraints: {},
    repairPolicy: {
      allowRepair: true,
      reproduction: {
        runRef: "run:123",
        runSha256: hashRepairValue("run-123"),
        evidenceId: "ripley-pe/__fixtures__/list.html",
        evidenceSha256: EVIDENCE,
        expectedFailureSha256: FAILURE,
        baselineCommit: BASE_COMMIT,
        baselineTreeSha256: BASELINE_TREE,
      },
    },
  } as const;
}

class OfflineHost implements RepairLifecycleHost {
  readonly applied: RepairChange[] = [];
  verifyCalls = 0;
  canaryCalls = 0;
  secondCanarySha256 = CANARY;
  reproductionKind: RepairCheck["kind"] = "parser";

  async createWorktree(): Promise<RepairWorkspace> {
    return { id: "isolated-worktree", root: "/tmp/isolated-worktree", baseCommit: BASE_COMMIT, baselineTreeSha256: BASELINE_TREE };
  }

  async readAllowedSources(): Promise<readonly { path: string; content: string; sha256: string }[]> {
    return [
      { path: EVIDENCE_PATH, content: "checked-in-fixture", sha256: EVIDENCE },
      { path: `${REPAIR_ROOT}/normalize.ts`, content: "export const repaired = false;\n", sha256: hashRepairValue("old") },
    ];
  }

  async reproduce(): Promise<RepairCheck> {
    return { ok: false, kind: this.reproductionKind, sha256: FAILURE, detail: "fixture parser drift" };
  }

  async applyChanges(_workspace: RepairWorkspace, changes: readonly RepairChange[]): Promise<void> {
    this.applied.push(...changes);
  }

  async diff(): Promise<RepairDiff> {
    return {
      text: "fixed deterministic diff",
      files: this.applied.map((change) => change.path),
      sha256: hashRepairValue("fixed deterministic diff"),
      fixturesSha256: hashRepairValue("fixture-set"),
    };
  }

  async verifyOffline(): Promise<RepairCheck> {
    this.verifyCalls += 1;
    return { ok: true, kind: "ok", sha256: CHECKS, detail: "fixed offline suite passed" };
  }

  async canary(): Promise<RepairCheck> {
    this.canaryCalls += 1;
    return {
      ok: true,
      kind: "ok",
      sha256: this.canaryCalls === 1 ? CANARY : this.secondCanarySha256,
      detail: "temporary static-registry canary passed",
    };
  }
}

const planner: RepairPlanner = {
  async propose() {
    return [CHANGE];
  },
};

async function candidate(host = new OfflineHost()): Promise<RepairCandidate> {
  return runRepairLifecycle({ composition: composeInvocation(repairManifest()), host, planner });
}

class PromotionHost implements RepairPromotionHost {
  readonly tracker: { active: number; maxActive: number };
  readonly applyStarted: Promise<void>;
  rollbackCalled = false;
  treeSha256 = BASELINE_TREE;
  canaryOk = true;
  blockApply = false;
  private signalApplyStarted!: () => void;
  private releaseApplyBarrier!: () => void;
  private readonly applyBarrier: Promise<void>;

  constructor(tracker = { active: 0, maxActive: 0 }) {
    this.tracker = tracker;
    const started = Promise.withResolvers<void>();
    this.applyStarted = started.promise;
    this.signalApplyStarted = started.resolve;
    const barrier = Promise.withResolvers<void>();
    this.applyBarrier = barrier.promise;
    this.releaseApplyBarrier = barrier.resolve;
  }

  releaseApply(): void {
    this.releaseApplyBarrier();
  }

  async capture(): Promise<PromotionSnapshot> {
    return { treeSha256: this.treeSha256, opaque: { before: this.treeSha256 } };
  }

  async apply(): Promise<void> {
    this.tracker.active += 1;
    this.tracker.maxActive = Math.max(this.tracker.maxActive, this.tracker.active);
    this.signalApplyStarted();
    if (this.blockApply) await this.applyBarrier;
    this.treeSha256 = hashRepairValue("promoted-tree");
    this.tracker.active -= 1;
  }

  async productionCanary(): Promise<RepairCheck> {
    return {
      ok: this.canaryOk,
      kind: this.canaryOk ? "ok" : "fixture",
      sha256: hashRepairValue(this.canaryOk ? "production-pass" : "production-fail"),
      detail: this.canaryOk ? "passed" : "failed",
    };
  }

  async rollback(snapshot: PromotionSnapshot): Promise<void> {
    this.rollbackCalled = true;
    this.treeSha256 = snapshot.treeSha256;
  }

  async currentTreeSha256(): Promise<string> {
    return this.treeSha256;
  }
}

const SITE: SiteDefinition = {
  site: "ripley-pe",
  scraperId: "ripley-pe-products",
  hosts: ["simple.ripley.com.pe"],
  canonicalization: { protocol: "https:", host: "simple.ripley.com.pe", stripHash: true },
  repairRoots: [REPAIR_ROOT],
  contextRefs: [`${REPAIR_ROOT}/products.ts`, `${REPAIR_ROOT}/normalize.ts`],
};

describe("explicit hash-bound repair lifecycle", () => {
  test("produces a reproducible candidate and stops at human approval", async () => {
    const host = new OfflineHost();
    const result = await candidate(host);
    expect(result.states).toEqual([
      "requested",
      "classified",
      "reproduced",
      "candidate_created",
      "patched_in_worktree",
      "offline_verified",
      "worktree_canary_passed",
      "independently_verified",
      "awaiting_approval",
    ]);
    expect(result.workspace.root).toContain("isolated-worktree");
    expect(result.changedFiles).toEqual([CHANGE.path]);
    expect(host.verifyCalls).toBe(2);
    expect(host.canaryCalls).toBe(2);
    assertCandidateIntegrity(result);
  });

  test("dispatches only an explicit repair Invocation to the repair executor", async () => {
    const repairExecutor = new LifecycleRepairInvocationExecutor(new OfflineHost(), planner, "fake/repair");
    const execution = await invokeOneShot(repairManifest(), {
      config: {
        models: { coordinator: "fake/coordinator", siteAgent: "fake/site", repairAgent: "fake/repair", verifier: "fake/verifier" },
        caps: { maxConcurrency: 3, maxDepth: 2, maxRuntimeMs: 5_000, maxLlmRequests: 10, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 10_000 },
      },
      sessionRunner: new DeterministicSessionRunner(),
      ingestExecutor: new DeterministicIngestExecutor(),
      repairExecutor,
    });
    expect(execution.result.status).toBe("partial");
    expect(execution.result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "repair_candidate",
      "repair_run",
      "repair_reproduction",
      "repair_diff",
      "repair_evidence",
      "repair_checks",
      "repair_canary",
    ]);
    expect(execution.states.at(-1)).toBe("awaiting_approval");
  });

  test.each([
    "../registry.ts",
    `${REPAIR_ROOT}/../../registry.ts`,
    `${REPAIR_ROOT}\\normalize.ts`,
    `${REPAIR_ROOT}/helper.ts`,
    "apps/ingest/src/scrapers/registry.ts",
  ])("rejects path or scope escape %s", (path) => {
    expect(() => assertRepairChangeScope(REPAIR_ROOT, [{ path, content: "x" }])).toThrow(/scope|allowlisted/);
  });

  test.each(["policy", "challenge", "circuit", "budget", "lease", "empty"] as const)(
    "does not create a patch for %s outcomes",
    async (kind) => {
      const host = new OfflineHost();
      host.reproductionKind = kind;
      await expect(candidate(host)).rejects.toThrow("repair-eligible");
      expect(host.applied).toHaveLength(0);
    },
  );

  test("rejects independent check/canary drift", async () => {
    const host = new OfflineHost();
    host.secondCanarySha256 = hashRepairValue("tampered-canary");
    await expect(candidate(host)).rejects.toThrow("independent verifier");
  });
});

describe("approval, serialized promotion, and rollback", () => {
  test("requires an explicit human approval; auto approval is unavailable by default", async () => {
    const current = await candidate();
    const approval = createHumanApproval(current, "operator@example.com");
    assertApprovalCurrent(current, approval);
    expect(() => assertApprovalCurrent(current, { ...approval, kind: "auto" } as never)).toThrow("does not bind");
  });

  test.each(["diffSha256", "evidenceSha256", "checksSha256", "canarySha256"] as const)(
    "invalidates approval after %s tampering",
    async (field) => {
      const current = await candidate();
      const approval = createHumanApproval(current, "operator@example.com");
      const tampered = structuredClone(current);
      tampered.hashes[field] = hashRepairValue(`tampered-${field}`);
      expect(() => assertApprovalCurrent(tampered, approval)).toThrow("candidate content hash mismatch");
    },
  );

  test("serializes concurrent promotions through one host write gate", async () => {
    const current = await candidate();
    const approval = createHumanApproval(current, "operator@example.com");
    const tracker = { active: 0, maxActive: 0 };
    const firstHost = new PromotionHost(tracker);
    const secondHost = new PromotionHost(tracker);
    firstHost.blockApply = true;
    const gate = new WriteGate();
    const first = promoteApprovedRepair({ candidate: current, approval, site: SITE, host: firstHost, writeGate: gate });
    const second = promoteApprovedRepair({ candidate: current, approval, site: SITE, host: secondHost, writeGate: gate });
    await firstHost.applyStarted;
    expect(tracker.active).toBe(1);
    expect(gate.maxObserved).toBe(1);
    firstHost.releaseApply();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.status === "healthy")).toBe(true);
    expect(tracker.maxActive).toBe(1);
    expect(gate.maxObserved).toBe(1);
  });

  test("rolls back to the exact prior hash when the post-promotion canary fails", async () => {
    const current = await candidate();
    const approval = createHumanApproval(current, "operator@example.com");
    const host = new PromotionHost();
    host.canaryOk = false;
    const result = await promoteApprovedRepair({ candidate: current, approval, site: SITE, host });
    expect(result.status).toBe("rolled_back");
    expect(result.states).toEqual(["approved", "promoted", "production_canary", "rolled_back"]);
    expect(host.rollbackCalled).toBe(true);
    expect(result.rollbackSha256).toBe(BASELINE_TREE);
  });

  test("refuses promotion if production no longer matches the candidate baseline", async () => {
    const current = await candidate();
    const approval = createHumanApproval(current, "operator@example.com");
    const host = new PromotionHost();
    host.treeSha256 = hashRepairValue("concurrent-production-change");
    await expect(promoteApprovedRepair({ candidate: current, approval, site: SITE, host })).rejects.toThrow(
      "production subtree changed",
    );
  });
});
