/** Injectable clock so scheduling/retry/circuit logic is deterministic in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
};

/**
 * A controllable clock for tests. `advance` fires any sleeps whose deadline has
 * passed. `tick` advances and awaits a microtask so scheduled continuations run.
 */
export class FakeClock implements Clock {
  private current: number;
  private readonly pending: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.pending.push({ at: this.current + ms, resolve });
    return promise;
  }

  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.pending.filter((p) => p.at <= this.current);
    for (const p of due) {
      this.pending.splice(this.pending.indexOf(p), 1);
      p.resolve();
    }
    // Let awaiting continuations run.
    await Promise.resolve();
  }
}
