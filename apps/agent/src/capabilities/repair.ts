import { InvocationResultSchema } from "@scrapito/contracts";
import { runRepairLifecycle } from "../repair/lifecycle.ts";
import type { RepairLifecycleHost, RepairPlanner } from "../repair/types.ts";
import type { AuditRecord, Composition, InvocationExecution, RepairInvocationExecutor } from "../types.ts";

export class LifecycleRepairInvocationExecutor implements RepairInvocationExecutor {
  constructor(
    private readonly host: RepairLifecycleHost,
    private readonly planner: RepairPlanner,
    private readonly model: string,
  ) {}

  async execute(composition: Composition): Promise<InvocationExecution> {
    const candidate = await runRepairLifecycle({ composition, host: this.host, planner: this.planner });
    const llm = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const timestamp = new Date().toISOString();
    const audit: AuditRecord[] = candidate.audit.map((entry) => ({
      timestamp,
      invocationId: candidate.invocationId,
      site: candidate.site,
      strategy: candidate.strategy,
      capability: "repair",
      state: entry.state,
      model: this.model,
      usage: llm,
      evidenceIds: [candidate.evidenceId],
      actionId: candidate.candidateId,
      detail: `${entry.detail}; hashes=${JSON.stringify(entry.hashRefs)}`,
    }));
    const result = InvocationResultSchema.parse({
      schemaVersion: 1,
      invocationId: candidate.invocationId,
      status: "partial",
      site: candidate.site,
      strategy: candidate.strategy,
      capability: "repair",
      run: null,
      coverage: null,
      artifacts: [
        { kind: "repair_candidate", ref: `candidate:${candidate.candidateId}`, sha256: candidate.hashes.candidateSha256 },
        { kind: "repair_run", ref: candidate.runRef, sha256: candidate.hashes.runSha256 },
        { kind: "repair_reproduction", ref: `candidate:${candidate.candidateId}:reproduction`, sha256: candidate.hashes.reproductionSha256 },
        { kind: "repair_diff", ref: `candidate:${candidate.candidateId}:diff`, sha256: candidate.hashes.diffSha256 },
        { kind: "repair_evidence", ref: `candidate:${candidate.candidateId}:evidence`, sha256: candidate.hashes.evidenceSha256 },
        { kind: "repair_checks", ref: `candidate:${candidate.candidateId}:checks`, sha256: candidate.hashes.checksSha256 },
        { kind: "repair_canary", ref: `candidate:${candidate.candidateId}:canary`, sha256: candidate.hashes.canarySha256 },
      ],
      usage: {
        requests: 0,
        durationMs: 0,
        writerDurationMs: 0,
        productsSaved: 0,
        productsSeen: 0,
        productsRejected: 0,
        duplicatesSeen: 0,
        imagesDownloaded: 0,
        llm: null,
      },
      error: null,
    });
    return { result, audit, states: candidate.states };
  }
}
