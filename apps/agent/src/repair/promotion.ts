import type { SiteDefinition } from "@scrapito/contracts";
import { AgentRuntimeError } from "../errors.ts";
import { WriteGate } from "../gates.ts";
import { assertCandidateIntegrity, hashRepairValue } from "./lifecycle.ts";
import type {
  RepairApproval,
  RepairAuditEvent,
  RepairCandidate,
  RepairCheck,
  RepairPromotionHost,
  RepairPromotionResult,
  RepairState,
} from "./types.ts";

const HUMAN_APPROVER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{1,127}$/;

export function createHumanApproval(candidate: RepairCandidate, approver: string): RepairApproval {
  assertCandidateIntegrity(candidate);
  if (candidate.states.at(-1) !== "awaiting_approval") {
    throw new AgentRuntimeError("REPAIR_APPROVAL_REJECTED", "candidate is not awaiting approval");
  }
  if (!HUMAN_APPROVER.test(approver)) {
    throw new AgentRuntimeError("REPAIR_APPROVAL_REJECTED", "a stable human approver identity is required");
  }
  const payload = {
    version: 1 as const,
    kind: "human" as const,
    approver,
    candidateId: candidate.candidateId,
    hashes: { ...candidate.hashes },
  };
  return { ...payload, approvalSha256: hashRepairValue(payload) };
}

export function assertApprovalCurrent(candidate: RepairCandidate, approval: RepairApproval): void {
  assertCandidateIntegrity(candidate);
  const { approvalSha256, ...payload } = approval;
  if (
    approval.kind !== "human" ||
    approval.candidateId !== candidate.candidateId ||
    hashRepairValue(payload) !== approvalSha256 ||
    hashRepairValue(approval.hashes) !== hashRepairValue(candidate.hashes)
  ) {
    throw new AgentRuntimeError("REPAIR_APPROVAL_STALE", "approval does not bind the current candidate hash bundle");
  }
}

function event(audit: RepairAuditEvent[], state: RepairState, detail: string, hashRefs: Record<string, string> = {}): void {
  audit.push({ sequence: audit.length + 1, state, detail, hashRefs });
}

export async function promoteApprovedRepair(input: {
  candidate: RepairCandidate;
  approval: RepairApproval;
  site: SiteDefinition;
  host: RepairPromotionHost;
  writeGate?: WriteGate;
}): Promise<RepairPromotionResult> {
  const { candidate, approval, site, host } = input;
  if (site.site !== candidate.site || site.repairRoots.length !== 1 || site.repairRoots[0] !== candidate.repairRoot) {
    throw new AgentRuntimeError("REPAIR_SCOPE_REJECTED", "promotion SiteDefinition does not match candidate scope");
  }
  assertApprovalCurrent(candidate, approval);
  const writeGate = input.writeGate ?? new WriteGate();
  return writeGate.run(async () => {
    assertApprovalCurrent(candidate, approval);
    const audit: RepairAuditEvent[] = [];
    event(audit, "approved", "human hash-bound approval accepted", { approval: approval.approvalSha256 });
    const snapshot = await host.capture(candidate.repairRoot, candidate.changedFiles);
    if (snapshot.treeSha256 !== candidate.hashes.baselineTreeSha256) {
      throw new AgentRuntimeError("REPAIR_BASELINE_MISMATCH", "production subtree changed after candidate creation");
    }

    let canary: RepairCheck;
    try {
      await host.apply(candidate.changes);
      event(audit, "promoted", "host applied approved files under the serialized write gate", {
        candidate: candidate.hashes.candidateSha256,
      });
      event(audit, "production_canary", "post-promotion offline canary started");
      canary = await host.productionCanary(site.scraperId);
    } catch (error) {
      canary = {
        ok: false,
        kind: "fixture",
        sha256: hashRepairValue({ error: error instanceof Error ? error.message : String(error) }),
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (canary.ok) {
      event(audit, "healthy", "post-promotion canary passed", { canary: canary.sha256 });
      return { status: "healthy", states: audit.map((entry) => entry.state), audit, canary, rollbackSha256: null };
    }

    try {
      await host.rollback(snapshot);
      const restoredSha256 = await host.currentTreeSha256(candidate.repairRoot);
      if (restoredSha256 !== snapshot.treeSha256) {
        throw new AgentRuntimeError("REPAIR_ROLLBACK_MISMATCH", "rollback did not restore the prior subtree hash");
      }
      event(audit, "rolled_back", "failed promotion restored the exact prior subtree hash", { rollback: restoredSha256 });
      return {
        status: "rolled_back",
        states: audit.map((entry) => entry.state),
        audit,
        canary,
        rollbackSha256: restoredSha256,
      };
    } catch (error) {
      const rollbackSha256 = hashRepairValue({ error: error instanceof Error ? error.message : String(error) });
      event(audit, "escalated", "rollback failed and requires operator intervention", { rollback: rollbackSha256 });
      return {
        status: "escalated",
        states: audit.map((entry) => entry.state),
        audit,
        canary,
        rollbackSha256,
      };
    }
  });
}
