import { describe, expect, test } from "bun:test";
import type { InvocationContext, InvocationResult } from "@scrapito/contracts";
import { AgentRuntimeError } from "./errors.ts";
import { WriteGate } from "./gates.ts";
import { invokeOneShot } from "./invocation.ts";
import type { AgentConfig, AgentSessionRunner, HostCaps, IngestExecutor, SessionRunInput, SessionRunOutput } from "./types.ts";

function config(overrides: Partial<HostCaps> = {}): AgentConfig {
  return {
    models: { coordinator: "pi/smol", siteAgent: "pi/smol", repairAgent: "pi/slow", verifier: "pi/task" },
    caps: {
      maxConcurrency: 3,
      maxDepth: 2,
      maxRuntimeMs: 60_000,
      maxLlmRequests: 16,
      maxCostUsd: 0.5,
      maxInputTokens: 200_000,
      maxOutputTokens: 40_000,
      ...overrides,
    },
  };
}

function categoryRaw(invocationId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    invocationId,
    intent: "acquire",
    site: "ripley-pe",
    strategy: "category",
    target: { kind: "category", externalId: "televisores" },
  };
}

function ingestDecision(): SessionRunOutput {
  return {
    decision: { action: "ingest", summary: "supported invocation", evidenceIds: [], actionId: "action-1" },
    usage: { requests: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    modelsUsed: ["fake/deterministic"],
  };
}

function validIngestResult(invocation: InvocationContext): InvocationResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    status: "completed",
    site: invocation.site,
    strategy: invocation.strategy,
    capability: invocation.intent,
    run: { runId: 1, scraperId: `fake-${invocation.site}`, status: "completed", startedAt: now, finishedAt: now },
    coverage: null,
    artifacts: [{ kind: "fake_ingest", ref: `fake:${invocation.invocationId}`, sha256: null }],
    usage: {
      requests: 1,
      durationMs: 1,
      writerDurationMs: 1,
      productsSaved: 1,
      productsSeen: 1,
      productsRejected: 0,
      duplicatesSeen: 0,
      imagesDownloaded: 0,
      llm: null,
    },
    error: null,
  };
}

class RecordingSessionRunner implements AgentSessionRunner {
  calls = 0;
  constructor(private readonly output: () => SessionRunOutput) {}
  async run(_input: SessionRunInput): Promise<SessionRunOutput> {
    this.calls += 1;
    return this.output();
  }
}

class RecordingIngestExecutor implements IngestExecutor {
  calls = 0;
  async execute(invocation: InvocationContext, _signal: AbortSignal): Promise<InvocationResult> {
    this.calls += 1;
    return validIngestResult(invocation);
  }
}

/** A writer that blocks until the test releases it, so overlapping
 * `invokeOneShot` calls can be observed mid-flight without a real timer. */
class BlockingIngestExecutor implements IngestExecutor {
  calls = 0;
  active = 0;
  peak = 0;
  #releasers: Array<() => void> = [];

  async execute(invocation: InvocationContext, _signal: AbortSignal): Promise<InvocationResult> {
    this.calls += 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#releasers.push(resolve);
    await promise;
    this.active -= 1;
    return validIngestResult(invocation);
  }

  releaseOne(): void {
    this.#releasers.shift()?.();
  }
}

/** Polls a condition across bounded microtask ticks; no real timer. Fails
 * loudly instead of hanging when the condition never becomes true. */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true within the microtask budget");
}

describe("invokeOneShot: fail-fast unsupported before runner/writer", () => {
  test("rejects an unsupported site/strategy/capability combination without calling the runner or the executor", async () => {
    const runner = new RecordingSessionRunner(ingestDecision);
    const executor = new RecordingIngestExecutor();
    const raw = {
      schemaVersion: 1,
      invocationId: "run-unsupported",
      intent: "acquire",
      site: "ripley-pe",
      strategy: "homepage",
      target: { kind: "homepage" },
    };

    let caught: unknown;
    try {
      await invokeOneShot(raw, { config: config(), sessionRunner: runner, ingestExecutor: executor, writeGate: new WriteGate() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe("UNSUPPORTED_INVOCATION");
    expect(runner.calls).toBe(0);
    expect(executor.calls).toBe(0);
  });

  test("rejects a manifest with an unrecognized field without calling the runner or the executor", async () => {
    const runner = new RecordingSessionRunner(ingestDecision);
    const executor = new RecordingIngestExecutor();
    const raw = { ...categoryRaw("run-strict"), notAllowed: true } as Record<string, unknown>;

    let caught: unknown;
    try {
      await invokeOneShot(raw, { config: config(), sessionRunner: runner, ingestExecutor: executor, writeGate: new WriteGate() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(AgentRuntimeError);
    expect(runner.calls).toBe(0);
    expect(executor.calls).toBe(0);
  });
});

describe("invokeOneShot: dry-run", () => {
  test("never calls the session runner or the ingest executor", async () => {
    const runner = new RecordingSessionRunner(ingestDecision);
    const executor = new RecordingIngestExecutor();

    await invokeOneShot(categoryRaw("run-dry"), {
      config: config(),
      sessionRunner: runner,
      ingestExecutor: executor,
      dryRun: true,
      writeGate: new WriteGate(),
    }).catch(() => {});

    expect(runner.calls).toBe(0);
    expect(executor.calls).toBe(0);
  });
});

describe("invokeOneShot: host budgets enforced before the write", () => {
  test("a session usage delta that exceeds the request cap blocks the ingest write", async () => {
    const runner = new RecordingSessionRunner(() => ({
      decision: { action: "ingest", summary: "over budget", evidenceIds: [], actionId: "action-1" },
      usage: { requests: 100, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      modelsUsed: ["fake"],
    }));
    const executor = new RecordingIngestExecutor();

    const execution = await invokeOneShot(categoryRaw("run-over-budget"), {
      config: config({ maxLlmRequests: 1 }),
      sessionRunner: runner,
      ingestExecutor: executor,
      writeGate: new WriteGate(),
    });

    expect(execution.result.status).toBe("partial");
    expect(execution.result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "budget_stop", ref: "REQUEST_BUDGET_EXCEEDED" }),
    );
    expect(runner.calls).toBe(1);
    expect(executor.calls).toBe(0);
  });

  test("a session usage delta that exceeds the cost cap blocks the ingest write", async () => {
    const runner = new RecordingSessionRunner(() => ({
      decision: { action: "ingest", summary: "over budget", evidenceIds: [], actionId: "action-1" },
      usage: { requests: 1, inputTokens: 0, outputTokens: 0, costUsd: 999 },
      modelsUsed: ["fake"],
    }));
    const executor = new RecordingIngestExecutor();

    const execution = await invokeOneShot(categoryRaw("run-over-cost"), {
      config: config({ maxCostUsd: 0.01 }),
      sessionRunner: runner,
      ingestExecutor: executor,
      writeGate: new WriteGate(),
    });

    expect(execution.result.status).toBe("partial");
    expect(execution.result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "budget_stop", ref: "COST_BUDGET_EXCEEDED" }),
    );
    expect(runner.calls).toBe(1);
    expect(executor.calls).toBe(0);
  });

  test("a session usage delta within every cap allows the ingest write to proceed", async () => {
    const runner = new RecordingSessionRunner(ingestDecision);
    const executor = new RecordingIngestExecutor();

    const execution = await invokeOneShot(categoryRaw("run-within-budget"), {
      config: config(),
      sessionRunner: runner,
      ingestExecutor: executor,
      writeGate: new WriteGate(),
    });

    expect(executor.calls).toBe(1);
    expect(execution.result.status).toBe("completed");
  });
});

describe("invokeOneShot: WriteGate serializes concurrent one-shot invocations", () => {
  test("two overlapping invokeOneShot calls sharing a WriteGate never write concurrently", async () => {
    const writeGate = new WriteGate();
    const executor = new BlockingIngestExecutor();

    const pendingA = invokeOneShot(categoryRaw("run-writer-a"), {
      config: config(),
      sessionRunner: new RecordingSessionRunner(ingestDecision),
      ingestExecutor: executor,
      writeGate,
    });
    const pendingB = invokeOneShot(categoryRaw("run-writer-b"), {
      config: config(),
      sessionRunner: new RecordingSessionRunner(ingestDecision),
      ingestExecutor: executor,
      writeGate,
    });

    await waitFor(() => executor.calls >= 1);
    expect(executor.active).toBe(1);
    expect(executor.calls).toBe(1); // the second writer must still be queued behind the gate

    executor.releaseOne();
    await waitFor(() => executor.calls >= 2);
    expect(executor.active).toBe(1); // gate admitted the next writer only after the first left

    executor.releaseOne();
    const [executionA, executionB] = await Promise.all([pendingA, pendingB]);

    expect(executor.peak).toBe(1);
    expect(executionA.result.status).toBe("completed");
    expect(executionB.result.status).toBe("completed");
  });
});

describe("invokeOneShot: deterministic invocation", () => {
  test("an identical supported manifest produces the same terminal status and state sequence across runs", async () => {
    const first = await invokeOneShot(categoryRaw("run-deterministic-a"), {
      config: config(),
      sessionRunner: new RecordingSessionRunner(ingestDecision),
      ingestExecutor: new RecordingIngestExecutor(),
      writeGate: new WriteGate(),
    });
    const second = await invokeOneShot(categoryRaw("run-deterministic-b"), {
      config: config(),
      sessionRunner: new RecordingSessionRunner(ingestDecision),
      ingestExecutor: new RecordingIngestExecutor(),
      writeGate: new WriteGate(),
    });

    expect(first.states).toEqual(second.states);
    expect(first.result.status).toBe(second.result.status);
    expect(first.result.site).toBe(second.result.site);
    expect(first.result.strategy).toBe(second.result.strategy);
    expect(first.result.capability).toBe(second.result.capability);
  });
});
