/**
 * Shared test doubles for the crawl-policy test suite. Not itself a test file
 * (no `.test.ts` suffix) so Bun's test runner never picks it up directly.
 */
import { FakeClock } from "./clock.ts";
import type { HttpFetch, RawResponse } from "./crawl-policy.ts";
import type { RobotsFetch } from "./robots.ts";

/** An honest bot identity: named, with a contact URL, per CrawlPolicy's validator. */
export const HONEST_UA = "ScrapMany/1.0 (+https://operator.example/bot-info)";

/** A browser-impersonating UA that CrawlPolicy must reject. */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface RecordedHttpCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  at: number;
}

type HttpResponder =
  | RawResponse
  | ((url: string, init: { method: string; headers: Record<string, string> }) => RawResponse);

/**
 * Records every call and serves queued responses per URL strictly FIFO.
 * Falls back to `setFallback` once a URL's queue is empty (or was never set).
 */
export class FakeHttpRouter {
  readonly calls: RecordedHttpCall[] = [];
  private readonly queues = new Map<string, HttpResponder[]>();
  private fallback?: HttpResponder;

  constructor(private readonly clock: FakeClock) {}

  /** Enqueue one-shot response(s) for a URL, consumed strictly FIFO (one per
   * matching call). Once the queue for a URL is empty, `fallback` (if set)
   * is used. Call `queue` again later to enqueue further one-shot responses
   * for future calls. */
  queue(url: string, ...responses: HttpResponder[]): this {
    const existing = this.queues.get(url) ?? [];
    existing.push(...responses);
    this.queues.set(url, existing);
    return this;
  }

  setFallback(responder: HttpResponder): this {
    this.fallback = responder;
    return this;
  }

  countCalls(url: string): number {
    return this.calls.filter((c) => c.url === url).length;
  }

  readonly fetch: HttpFetch = async (url, init) => {
    this.calls.push({ url, method: init.method, headers: init.headers, at: this.clock.now() });
    const queue = this.queues.get(url);
    const responder = queue && queue.length > 0 ? queue.shift() : this.fallback;
    if (!responder) throw new Error(`FakeHttpRouter: no response configured for ${url}`);
    return typeof responder === "function" ? responder(url, init) : responder;
  };
}

/** Robots.txt response that unconditionally allows everything, for any host. */
export const ALLOW_ALL_ROBOTS: RobotsFetch = async () => ({
  status: 200,
  body: "User-agent: *\nAllow: /\n",
});

type RobotsEntryConfig =
  | { status: number; body: string; location?: string }
  | Error;

/** A per-host scriptable RobotsFetch spy, for asserting cache/call-count behavior. */
export function makeRobotsFetch(byHost: Record<string, RobotsEntryConfig>): {
  fetch: RobotsFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: RobotsFetch = async (url) => {
    calls.push(url);
    const host = new URL(url).hostname;
    const entry = byHost[host];
    if (entry === undefined) throw new Error(`makeRobotsFetch: no fixture for host ${host}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { fetch, calls };
}

/**
 * Drive a FakeClock forward in coarse steps until `promise` settles, then
 * return its resolution or re-throw its rejection. Needed because retry
 * backoff, Retry-After sleeps, and scheduler spacing all await
 * `clock.sleep(...)`, which only fires once the clock is advanced past it.
 */
export async function drain<T>(
  clock: FakeClock,
  promise: Promise<T>,
  opts: { stepMs?: number; maxSteps?: number } = {},
): Promise<T> {
  const stepMs = opts.stepMs ?? 60_000;
  const maxSteps = opts.maxSteps ?? 50;
  let settled = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  promise.then(
    (value) => {
      settled = true;
      outcome = { ok: true, value };
    },
    (error: unknown) => {
      settled = true;
      outcome = { ok: false, error };
    },
  );
  for (let i = 0; i < maxSteps && !settled; i++) {
    await clock.advance(stepMs);
    // A real macrotask yield (not just a microtask tick) so deep await chains
    // and native async work (e.g. crypto.subtle.digest) fully flush before the
    // next clock jump — a single `await Promise.resolve()` is not enough for
    // multi-hop chains (robots -> scheduler -> httpFetch -> hashing -> ...).
    const { promise: tick, resolve: fireTick } = Promise.withResolvers<void>();
    setTimeout(fireTick, 0);
    await tick;
  }
  if (!settled || !outcome) {
    throw new Error("drain: promise did not settle within the allotted steps");
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
