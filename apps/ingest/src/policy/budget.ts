import { BudgetExhaustedError } from "@scrapito/contracts";
import type { Clock } from "./clock.ts";

/** Per-run request + duration budget. Throws BudgetExhaustedError when exceeded. */
export class RequestBudget {
  private requests = 0;
  private readonly startedAt: number;

  constructor(
    private readonly maxRequests: number,
    private readonly maxDurationMs: number,
    private readonly clock: Clock,
  ) {
    this.startedAt = clock.now();
  }

  /** True when either budget is exhausted (checked before spending). */
  isExhausted(): boolean {
    return (
      this.requests >= this.maxRequests ||
      this.clock.now() - this.startedAt >= this.maxDurationMs
    );
  }

  /** Reserve one request; throws when no budget remains. */
  consume(): void {
    if (this.isExhausted()) {
      throw new BudgetExhaustedError("run budget exhausted", {
        requests: this.requests,
        maxRequests: this.maxRequests,
        elapsedMs: this.clock.now() - this.startedAt,
        maxDurationMs: this.maxDurationMs,
      });
    }
    this.requests++;
  }

  get used(): number {
    return this.requests;
  }
}
