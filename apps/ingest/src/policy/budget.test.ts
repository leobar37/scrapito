import { describe, expect, test } from "bun:test";
import { BudgetExhaustedError } from "@scrapito/contracts";
import { RequestBudget } from "./budget.ts";
import { FakeClock } from "./clock.ts";

describe("RequestBudget", () => {
  test("allows consuming up to maxRequests, then throws BudgetExhaustedError", () => {
    const clock = new FakeClock(0);
    const budget = new RequestBudget(3, 1_000_000, clock);
    budget.consume();
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(3);
    expect(() => budget.consume()).toThrow(BudgetExhaustedError);
    // A failed consume() must not have incremented the counter further.
    expect(budget.used).toBe(3);
  });

  test("throws once maxDurationMs has elapsed even with requests remaining", async () => {
    const clock = new FakeClock(0);
    const budget = new RequestBudget(100, 5_000, clock);
    budget.consume();
    await clock.advance(5_000);
    expect(() => budget.consume()).toThrow(BudgetExhaustedError);
  });

  test("isExhausted reflects state without mutating the counter", () => {
    const clock = new FakeClock(0);
    const budget = new RequestBudget(1, 1_000_000, clock);
    expect(budget.isExhausted()).toBe(false);
    budget.consume();
    expect(budget.isExhausted()).toBe(true);
    expect(budget.used).toBe(1);
  });
});
