import {
  CapabilityIdSchema,
  InvocationResultSchema,
  StoreIdSchema,
  StrategyIdSchema,
  type InvocationContext,
  type InvocationResult,
} from "@scrapito/contracts";
import { AuditTrail } from "./audit.ts";
import { HostBudgetLedger, ZERO_LLM_USAGE, withRuntimeDeadline } from "./budget.ts";
import { composeInvocation } from "./composition.ts";
import { AgentRuntimeError } from "./errors.ts";
import { WriteGate } from "./gates.ts";
import type {
  AgentConfig,
  AgentSessionRunner,
  IngestExecutor,
  InvocationExecution,
  RepairInvocationExecutor,
  InvocationState,
  LlmUsage,
} from "./types.ts";

const HOST_WRITE_GATE = new WriteGate();

function emptyUsage(durationMs = 0): InvocationResult["usage"] {
  return {
    requests: 0,
    durationMs,
    writerDurationMs: 0,
    productsSaved: 0,
    productsSeen: 0,
    productsRejected: 0,
    duplicatesSeen: 0,
    imagesDownloaded: 0,
    llm: null,
  };
}

function rejectedIdentity(raw: unknown): Pick<InvocationResult, "invocationId" | "site" | "strategy" | "capability"> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const invocationId = typeof value.invocationId === "string" && value.invocationId.trim() ? value.invocationId : "invalid-manifest";
  const site = StoreIdSchema.safeParse(value.site);
  const strategy = StrategyIdSchema.safeParse(value.strategy);
  const capability = CapabilityIdSchema.safeParse(value.intent);
  return {
    invocationId,
    site: site.success ? site.data : "ripley-pe",
    strategy: strategy.success ? strategy.data : "homepage",
    capability: capability.success ? capability.data : "inspect",
  };
}

export function rejectedInvocationResult(raw: unknown, error: unknown): InvocationResult {
  const runtimeError = error instanceof AgentRuntimeError ? error : undefined;
  return InvocationResultSchema.parse({
    schemaVersion: 1,
    ...rejectedIdentity(raw),
    status: "rejected",
    run: null,
    coverage: null,
    artifacts: [],
    usage: emptyUsage(),
    error: {
      code: runtimeError?.code ?? "BAD_MANIFEST",
      message: error instanceof Error ? error.message : String(error),
      ...(runtimeError?.details !== undefined ? { details: runtimeError.details } : {}),
    },
  });
}

function terminalWithoutWrite(
  invocation: InvocationContext,
  status: "partial" | "failed" | "rejected",
  artifacts: InvocationResult["artifacts"],
  usage: LlmUsage,
  durationMs: number,
  error?: AgentRuntimeError,
): InvocationResult {
  return InvocationResultSchema.parse({
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    status,
    site: invocation.site,
    strategy: invocation.strategy,
    capability: invocation.intent,
    run: null,
    coverage: null,
    artifacts,
    usage: {
      ...emptyUsage(durationMs),
      llm: usage.requests === 0
        ? null
        : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
    },
    error: status === "failed" || status === "rejected"
      ? { code: error?.code ?? "AGENT_REJECTED", message: error?.message ?? "agent rejected the invocation" }
      : null,
  });
}

export interface InvokeOptions {
  config: AgentConfig;
  sessionRunner: AgentSessionRunner;
  ingestExecutor: IngestExecutor;
  repairExecutor?: RepairInvocationExecutor;
  dryRun?: boolean;
  writeGate?: WriteGate;
}

export async function invokeOneShot(raw: unknown, options: InvokeOptions): Promise<InvocationExecution> {
  const composition = composeInvocation(raw);
  const invocation = composition.invocation;
  const states: InvocationState[] = ["accepted"];
  const ledger = new HostBudgetLedger(options.config.caps);
  const audit = new AuditTrail(composition, options.config.models.coordinator);
  audit.append("accepted", "manifest accepted", ledger.usage, composition.evidence);
  states.push("preflight");
  audit.append("preflight", "support matrix accepted", ledger.usage, composition.evidence);

  if (options.dryRun) {
    states.push("terminal");
    audit.append("terminal", "dry-run completed without OMP, network, database, or write", ledger.usage, composition.evidence, `dry-${invocation.invocationId}`);
    const auditArtifact = audit.artifact();
    const result = InvocationResultSchema.parse({
      schemaVersion: 1,
      invocationId: invocation.invocationId,
      status: "partial",
      site: invocation.site,
      strategy: invocation.strategy,
      capability: invocation.intent,
      run: null,
      coverage: null,
      artifacts: [
        { kind: "dry_run", ref: `dry-run:${invocation.invocationId}`, sha256: null },
        auditArtifact,
      ],
      usage: emptyUsage(ledger.elapsedMs),
      error: null,
    });
    return { result, audit: audit.snapshot(), states };
  }

  try {
    if (invocation.intent === "repair") {
      if (!options.repairExecutor) {
        throw new AgentRuntimeError("REPAIR_EXECUTOR_UNAVAILABLE", "explicit repair runtime is not configured");
      }
      return await options.repairExecutor.execute(composition);
    }
    return await withRuntimeDeadline(options.config.caps.maxRuntimeMs, async (signal) => {
      states.push("analyzing");
      audit.append("analyzing", "OMP coordinator started", ledger.usage, composition.evidence);
      const analysis = await options.sessionRunner.run({ composition, config: options.config, signal });
      ledger.charge(analysis.usage);
      audit.append(
        "analyzing",
        `OMP action ${analysis.decision.action}; models=${analysis.modelsUsed.join(",")}`,
        ledger.usage,
        analysis.decision.evidenceIds,
        analysis.decision.actionId,
      );

      if (analysis.decision.action !== "ingest") {
        states.push("terminal");
        const error = new AgentRuntimeError(
          analysis.decision.action === "defer" ? "AGENT_DEFERRED" : "AGENT_REJECTED",
          analysis.decision.summary,
        );
        audit.append("terminal", error.message, ledger.usage, analysis.decision.evidenceIds, analysis.decision.actionId);
        const result = terminalWithoutWrite(invocation, "rejected", [audit.artifact()], ledger.usage, ledger.elapsedMs, error);
        return { result, audit: audit.snapshot(), states };
      }

      ledger.assertWithinCaps();
      states.push("waiting_write");
      audit.append("waiting_write", "waiting for host writer gate", ledger.usage, analysis.decision.evidenceIds, analysis.decision.actionId);
      const writeGate = options.writeGate ?? HOST_WRITE_GATE;
      const result = await writeGate.run(async () => {
        ledger.assertWithinCaps();
        states.push("executing");
        audit.append("executing", "fixed scrap-ingest subprocess started", ledger.usage, analysis.decision.evidenceIds, analysis.decision.actionId);
        return options.ingestExecutor.execute(invocation, signal);
      });

      states.push("evaluating");
      audit.append("evaluating", `ingest returned ${result.status}`, ledger.usage, analysis.decision.evidenceIds, analysis.decision.actionId);
      states.push("terminal");
      audit.append("terminal", "one-shot invocation finished", ledger.usage, analysis.decision.evidenceIds, analysis.decision.actionId);
      const llm = ledger.usage;
      const merged = InvocationResultSchema.parse({
        ...result,
        artifacts: [...result.artifacts, audit.artifact()],
        usage: {
          ...result.usage,
          durationMs: Math.max(result.usage.durationMs, ledger.elapsedMs),
          llm: { inputTokens: llm.inputTokens, outputTokens: llm.outputTokens, costUsd: llm.costUsd },
        },
      });
      return { result: merged, audit: audit.snapshot(), states };
    });
  } catch (error) {
    const runtimeError = error instanceof AgentRuntimeError
      ? error
      : new AgentRuntimeError("AGENT_RUNTIME_FAILED", error instanceof Error ? error.message : String(error));
    const budgetStop = runtimeError.code.includes("BUDGET_EXCEEDED");
    if (states.at(-1) !== "terminal") states.push("terminal");
    audit.append("terminal", runtimeError.message, ledger.usage, composition.evidence);
    const artifact = audit.artifact();
    const result = terminalWithoutWrite(
      invocation,
      budgetStop ? "partial" : "failed",
      budgetStop
        ? [{ kind: "budget_stop", ref: runtimeError.code, sha256: null }, artifact]
        : [artifact],
      ledger.usage,
      ledger.elapsedMs,
      budgetStop ? undefined : runtimeError,
    );
    return { result, audit: audit.snapshot(), states };
  }
}
