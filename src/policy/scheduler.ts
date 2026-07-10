/**
 * Request scheduler enforcing a shared global semaphore, per-host FIFO ordering,
 * one in-flight request per host, per-host spacing delays, and document-before-
 * image priority. Storefront documents get a 1,500-3,000 ms uniform delay;
 * images get 250-750 ms. Concurrency above four per host is rejected.
 */
import type { Clock } from "./clock.ts";

export type RequestClass = "document" | "image";

export interface SchedulerOptions {
  clock: Clock;
  globalLimit?: number;
  random?: () => number;
  documentDelayMinMs?: number;
  documentDelayMaxMs?: number;
  imageDelayMinMs?: number;
  imageDelayMaxMs?: number;
}

interface Waiter {
  host: string;
  cls: RequestClass;
  enqueuedAt: number;
  resolve: () => void;
}

const MAX_GLOBAL_LIMIT = 4;

export class Scheduler {
  private readonly clock: Clock;
  private readonly globalLimit: number;
  private readonly random: () => number;
  private readonly docMin: number;
  private readonly docMax: number;
  private readonly imgMin: number;
  private readonly imgMax: number;

  private globalInFlight = 0;
  private readonly hostInFlight = new Map<string, number>();
  private readonly hostNextAt = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private wakeScheduledFor = Infinity;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    const requested = options.globalLimit ?? MAX_GLOBAL_LIMIT;
    if (requested > MAX_GLOBAL_LIMIT) {
      throw new Error(`global concurrency limit may not exceed ${MAX_GLOBAL_LIMIT}`);
    }
    this.globalLimit = Math.max(1, requested);
    this.random = options.random ?? Math.random;
    this.docMin = options.documentDelayMinMs ?? 1500;
    this.docMax = options.documentDelayMaxMs ?? 3000;
    this.imgMin = options.imageDelayMinMs ?? 250;
    this.imgMax = options.imageDelayMaxMs ?? 750;
  }

  private delayFor(cls: RequestClass): number {
    const [min, max] = cls === "document" ? [this.docMin, this.docMax] : [this.imgMin, this.imgMax];
    return Math.round(min + this.random() * (max - min));
  }

  private canRun(w: Waiter): boolean {
    if (this.globalInFlight >= this.globalLimit) return false;
    if ((this.hostInFlight.get(w.host) ?? 0) >= 1) return false;
    if (this.clock.now() < (this.hostNextAt.get(w.host) ?? 0)) return false;
    return true;
  }

  /** Pick the next eligible waiter, preferring documents, then FIFO. */
  private pump(): void {
    for (let i = 0; i < 2; i++) {
      const preferred: RequestClass = i === 0 ? "document" : "image";
      const idx = this.waiters.findIndex((w) => w.cls === preferred && this.canRun(w));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        if (!w) continue;
        this.globalInFlight++;
        this.hostInFlight.set(w.host, (this.hostInFlight.get(w.host) ?? 0) + 1);
        w.resolve();
        // Try to fill more slots.
        this.pump();
        return;
      }
    }
    this.scheduleWake();
  }

  /**
   * When waiters are blocked only by per-host spacing (a global slot is free and
   * the host is idle), sleep until the earliest such host is eligible, then pump.
   */
  private scheduleWake(): void {
    if (this.globalInFlight >= this.globalLimit) return;
    let earliest = Infinity;
    for (const w of this.waiters) {
      if ((this.hostInFlight.get(w.host) ?? 0) >= 1) continue;
      const at = this.hostNextAt.get(w.host) ?? 0;
      if (at > this.clock.now() && at < earliest) earliest = at;
    }
    if (earliest === Infinity || earliest >= this.wakeScheduledFor) return;
    this.wakeScheduledFor = earliest;
    const wait = Math.max(1, earliest - this.clock.now());
    void this.clock.sleep(wait).then(() => {
      this.wakeScheduledFor = Infinity;
      this.pump();
    });
  }

  /**
   * Acquire a scheduling slot for `host`/`cls`. Resolves when the request may
   * proceed. Callers MUST call the returned release() exactly once.
   */
  async acquire(host: string, cls: RequestClass): Promise<() => void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiter: Waiter = { host, cls, enqueuedAt: this.clock.now(), resolve };
    this.waiters.push(waiter);
    this.pump();
    await promise;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalInFlight = Math.max(0, this.globalInFlight - 1);
      const inFlight = (this.hostInFlight.get(host) ?? 1) - 1;
      this.hostInFlight.set(host, Math.max(0, inFlight));
      // Space the next request to this host.
      this.hostNextAt.set(host, this.clock.now() + this.delayFor(cls));
      this.pump();
    };
  }

  /** Push the host's next-eligible time forward (e.g. Retry-After). */
  penalize(host: string, ms: number): void {
    const target = this.clock.now() + ms;
    if (target > (this.hostNextAt.get(host) ?? 0)) {
      this.hostNextAt.set(host, target);
    }
  }

  nextAvailableAt(host: string): number {
    return this.hostNextAt.get(host) ?? 0;
  }

  /** Re-run the pump (used after time advances so delayed hosts can proceed). */
  poke(): void {
    this.pump();
  }
}
