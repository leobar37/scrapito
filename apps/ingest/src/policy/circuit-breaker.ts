/**
 * Per-host circuit breaker. Opens after five consecutive qualifying failures or
 * a failure rate above 50% over the last 20 requests. Cools down 15 minutes,
 * doubling on repeated trips up to 2 hours. A challenge/CAPTCHA opens it
 * immediately.
 */
import type { Clock } from "./clock.ts";

const CONSECUTIVE_THRESHOLD = 5;
const WINDOW_SIZE = 20;
const FAILURE_RATE_THRESHOLD = 0.5;
const BASE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export type CircuitState = "closed" | "open";

interface HostCircuit {
  window: boolean[]; // true = failure
  consecutiveFailures: number;
  state: CircuitState;
  openedAt: number;
  cooldownMs: number;
  trips: number;
}

export class CircuitBreaker {
  private readonly hosts = new Map<string, HostCircuit>();

  constructor(private readonly clock: Clock) {}

  private get(host: string): HostCircuit {
    let c = this.hosts.get(host);
    if (!c) {
      c = {
        window: [],
        consecutiveFailures: 0,
        state: "closed",
        openedAt: 0,
        cooldownMs: BASE_COOLDOWN_MS,
        trips: 0,
      };
      this.hosts.set(host, c);
    }
    return c;
  }

  /** True when the host circuit is currently open (still cooling down). */
  isOpen(host: string): boolean {
    const c = this.get(host);
    if (c.state !== "open") return false;
    if (this.clock.now() - c.openedAt >= c.cooldownMs) {
      // Cooldown elapsed: half-close (treat as closed; next failure reopens).
      c.state = "closed";
      c.consecutiveFailures = 0;
      c.window = [];
      return false;
    }
    return true;
  }

  state(host: string): CircuitState {
    return this.isOpen(host) ? "open" : this.get(host).state;
  }

  /** Milliseconds until the open circuit is eligible to half-close. */
  cooldownRemaining(host: string): number {
    const c = this.get(host);
    if (c.state !== "open") return 0;
    return Math.max(0, c.cooldownMs - (this.clock.now() - c.openedAt));
  }

  recordSuccess(host: string): void {
    const c = this.get(host);
    c.consecutiveFailures = 0;
    c.window.push(false);
    if (c.window.length > WINDOW_SIZE) c.window.shift();
  }

  recordFailure(host: string): void {
    const c = this.get(host);
    c.consecutiveFailures++;
    c.window.push(true);
    if (c.window.length > WINDOW_SIZE) c.window.shift();
    const failures = c.window.filter((f) => f).length;
    const rateExceeded =
      c.window.length === WINDOW_SIZE && failures / c.window.length > FAILURE_RATE_THRESHOLD;
    if (c.consecutiveFailures >= CONSECUTIVE_THRESHOLD || rateExceeded) {
      this.trip(host);
    }
  }

  /** Open the circuit immediately (challenge/CAPTCHA). */
  tripImmediately(host: string): void {
    this.trip(host);
  }

  private trip(host: string): void {
    const c = this.get(host);
    if (c.state === "open") return;
    c.state = "open";
    c.openedAt = this.clock.now();
    c.cooldownMs = Math.min(BASE_COOLDOWN_MS * 2 ** c.trips, MAX_COOLDOWN_MS);
    c.trips++;
  }
}
