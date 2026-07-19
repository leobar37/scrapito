import { AgentRuntimeError } from "./errors.ts";
import type { HostCaps, LlmUsage } from "./types.ts";

export const ZERO_LLM_USAGE: LlmUsage = Object.freeze({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export class HostBudgetLedger {
  readonly #startedAt = Date.now();
  #usage: LlmUsage = { ...ZERO_LLM_USAGE };

  constructor(readonly caps: HostCaps) {}

  get usage(): LlmUsage {
    return { ...this.#usage };
  }

  get elapsedMs(): number {
    return Math.max(0, Date.now() - this.#startedAt);
  }

  charge(delta: Partial<LlmUsage>): void {
    this.#usage = {
      requests: this.#usage.requests + (delta.requests ?? 0),
      inputTokens: this.#usage.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: this.#usage.outputTokens + (delta.outputTokens ?? 0),
      costUsd: this.#usage.costUsd + (delta.costUsd ?? 0),
    };
    this.assertWithinCaps();
  }

  assertWithinCaps(): void {
    const checks: Array<[boolean, string, number, number]> = [
      [this.elapsedMs <= this.caps.maxRuntimeMs, "RUNTIME_BUDGET_EXCEEDED", this.elapsedMs, this.caps.maxRuntimeMs],
      [this.#usage.requests <= this.caps.maxLlmRequests, "REQUEST_BUDGET_EXCEEDED", this.#usage.requests, this.caps.maxLlmRequests],
      [this.#usage.costUsd <= this.caps.maxCostUsd, "COST_BUDGET_EXCEEDED", this.#usage.costUsd, this.caps.maxCostUsd],
      [this.#usage.inputTokens <= this.caps.maxInputTokens, "INPUT_TOKEN_BUDGET_EXCEEDED", this.#usage.inputTokens, this.caps.maxInputTokens],
      [this.#usage.outputTokens <= this.caps.maxOutputTokens, "OUTPUT_TOKEN_BUDGET_EXCEEDED", this.#usage.outputTokens, this.caps.maxOutputTokens],
    ];
    for (const [ok, code, observed, hard] of checks) {
      if (!ok) throw new AgentRuntimeError(code, `${code}: ${observed} > ${hard}`, { observed, hard });
    }
  }
}

export async function withRuntimeDeadline<T>(maxRuntimeMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AgentRuntimeError("RUNTIME_BUDGET_EXCEEDED", "invocation runtime expired")), maxRuntimeMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
