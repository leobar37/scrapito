import { describe, expect, test } from "bun:test";
import { ConcurrencyGate, WriteGate } from "./gates.ts";

/** Drains the microtask queue so every promise-chain hop a gate release
 * triggers (waiter resolve -> queued run() resume -> operation start) has
 * settled before the next assertion. Pure microtask ticks, no real timer. */
async function drainMicrotasks(ticks = 20): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

describe("ConcurrencyGate", () => {
  test("rejects a non-positive or fractional limit", () => {
    expect(() => new ConcurrencyGate(0)).toThrow();
    expect(() => new ConcurrencyGate(-1)).toThrow();
    expect(() => new ConcurrencyGate(1.5)).toThrow();
  });

  test("admits up to the limit concurrently and queues the rest until a slot frees", async () => {
    const gate = new ConcurrencyGate(3);
    let active = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];

    const operations = Array.from({ length: 6 }, () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        const { promise, resolve } = Promise.withResolvers<void>();
        releasers.push(resolve);
        await promise;
        active -= 1;
      }),
    );

    // The first 3 slots run synchronously up to their internal await; the
    // remaining 3 are parked in the waiter queue without incrementing active.
    expect(active).toBe(3);
    expect(releasers.length).toBe(3);

    releasers.splice(0, 3).forEach((resolve) => resolve());
    await drainMicrotasks();

    // Releasing the first batch admits exactly the next 3, never more.
    expect(active).toBe(3);
    expect(releasers.length).toBe(3);

    releasers.splice(0, 3).forEach((resolve) => resolve());
    await Promise.all(operations);

    expect(active).toBe(0);
    expect(peak).toBe(3);
  });
});

describe("WriteGate", () => {
  test("is a ConcurrencyGate hard-capped at 1 regardless of construction arguments", () => {
    const gate = new WriteGate();
    expect(gate.limit).toBe(1);
  });

  test("serializes overlapping writers: never more than one active at a time", async () => {
    const gate = new WriteGate();
    let active = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];

    const operations = Array.from({ length: 4 }, () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        const { promise, resolve } = Promise.withResolvers<void>();
        releasers.push(resolve);
        await promise;
        active -= 1;
      }),
    );

    for (let round = 0; round < 4; round += 1) {
      // At most one active writer must exist before each release, and never
      // more than one active writer at any point across the whole run.
      expect(active).toBe(1);
      expect(releasers.length).toBe(1);
      releasers.splice(0, 1).forEach((resolve) => resolve());
      await drainMicrotasks();
    }

    await Promise.all(operations);
    expect(peak).toBe(1);
  });

  test("propagates a failing writer without leaking the slot to the next waiter", async () => {
    const gate = new WriteGate();
    const failing = gate.run(async () => {
      throw new Error("writer exploded");
    });
    await expect(failing).rejects.toThrow("writer exploded");

    // The failed run must still release its slot for the next writer.
    const following = await gate.run(async () => "recovered");
    expect(following).toBe("recovered");
    expect(gate.maxObserved).toBe(1);
  });
});
