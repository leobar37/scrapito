import { describe, expect, test } from "bun:test";
import { AgentRuntimeError } from "./errors.ts";
import { HostBudgetLedger, ZERO_LLM_USAGE, withRuntimeDeadline } from "./budget.ts";
import type { HostCaps } from "./types.ts";

function caps(overrides: Partial<HostCaps> = {}): HostCaps {
  return {
    maxConcurrency: 3,
    maxDepth: 2,
    maxRuntimeMs: 60_000,
    maxLlmRequests: 10,
    maxCostUsd: 1,
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    ...overrides,
  };
}

describe("HostBudgetLedger.charge", () => {
  test("accumulates usage across multiple charges", () => {
    const ledger = new HostBudgetLedger(caps());
    ledger.charge({ requests: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.1 });
    ledger.charge({ requests: 2, inputTokens: 50, outputTokens: 10, costUsd: 0.05 });
    const usage = ledger.usage;
    expect(usage).toMatchObject({ requests: 3, inputTokens: 150, outputTokens: 30 });
    expect(usage.costUsd).toBeCloseTo(0.15, 10);
  });

  test("charging with an empty delta is a no-op on the running total", () => {
    const ledger = new HostBudgetLedger(caps());
    ledger.charge({ requests: 4, costUsd: 0.2 });
    ledger.charge({});
    expect(ledger.usage).toEqual({ requests: 4, inputTokens: 0, outputTokens: 0, costUsd: 0.2 });
  });

  test.each([
    ["requests", { requests: 11 }, "REQUEST_BUDGET_EXCEEDED"],
    ["costUsd", { costUsd: 1.01 }, "COST_BUDGET_EXCEEDED"],
    ["inputTokens", { inputTokens: 10_001 }, "INPUT_TOKEN_BUDGET_EXCEEDED"],
    ["outputTokens", { outputTokens: 10_001 }, "OUTPUT_TOKEN_BUDGET_EXCEEDED"],
  ] as const)("throws %s-mapped %s once the delta crosses the cap", (_field, delta, expectedCode) => {
    const ledger = new HostBudgetLedger(caps());
    let caught: unknown;
    try {
      ledger.charge(delta);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe(expectedCode);
  });

  test("a charge that trips the cap still applies its delta to the running total", () => {
    const ledger = new HostBudgetLedger(caps({ maxLlmRequests: 1 }));
    expect(() => ledger.charge({ requests: 2 })).toThrow(AgentRuntimeError);
    expect(ledger.usage.requests).toBe(2);
  });

  test("a value exactly at the cap does not throw", () => {
    const ledger = new HostBudgetLedger(caps({ maxLlmRequests: 3 }));
    expect(() => ledger.charge({ requests: 3 })).not.toThrow();
  });
});

describe("ZERO_LLM_USAGE", () => {
  test("is frozen so a shared reference cannot be mutated by a caller", () => {
    expect(Object.isFrozen(ZERO_LLM_USAGE)).toBe(true);
  });
});

describe("withRuntimeDeadline", () => {
  test("resolves with the operation's result when it finishes before the deadline", async () => {
    const result = await withRuntimeDeadline(1_000, async (signal) => {
      expect(signal.aborted).toBe(false);
      return "done";
    });
    expect(result).toBe("done");
  });

  test("aborts the signal with RUNTIME_BUDGET_EXCEEDED once the deadline elapses", async () => {
    let observedSignal: AbortSignal | undefined;
    const result = await withRuntimeDeadline(1, (signal) => {
      observedSignal = signal;
      const { promise, resolve } = Promise.withResolvers<string>();
      signal.addEventListener("abort", () => resolve("aborted"));
      return promise;
    });
    expect(result).toBe("aborted");
    expect(observedSignal?.aborted).toBe(true);
    expect((observedSignal?.reason as AgentRuntimeError)?.code).toBe("RUNTIME_BUDGET_EXCEEDED");
  });
});
