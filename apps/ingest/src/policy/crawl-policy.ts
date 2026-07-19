/**
 * CrawlPolicy — the single choke point consulted before every HTTP request and
 * browser navigation. Enforces host allowlist, robots, safety-floor exclusions,
 * honest user-agent, scheduling/pacing, retries with Retry-After, per-host
 * circuit breaking, and conditional-request / freshness caching.
 */
import {
  ChallengeDetectedError,
  CircuitOpenError,
  PolicyError,
} from "@scrapito/contracts";
import { nullLogger, type Logger } from "../util/logger.ts";
import {
  FORBIDDEN_HOSTS,
  isHostAllowed,
  isImageHost,
  isPrivateHost,
  isSafetyFloorBlocked,
} from "./allowlist.ts";
import { RequestBudget } from "./budget.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { systemClock, type Clock } from "./clock.ts";
import { MemoryHttpCache, type HttpCacheEntry, type HttpCacheStore } from "./http-cache.ts";
import { RobotsCache, type RobotsFetch } from "./robots.ts";
import { Scheduler, type RequestClass } from "./scheduler.ts";
import { canonicalizeUrl } from "./url-utils.ts";

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: "manual" },
) => Promise<RawResponse>;

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  class?: RequestClass;
  budget?: RequestBudget;
  /** Freshness floor override in ms (defaults: 24h doc, 7d image). */
  freshnessMs?: number;
}

export interface PolicyResponse {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyHash: string | null;
  etag: string | null;
  lastModified: string | null;
  fromCache: boolean;
  notModified: boolean;
}

export interface RawImageResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export type ImageFetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: "manual" },
) => Promise<RawImageResponse>;

export interface PolicyImageResponse {
  url: string;
  status: number;
  bytes: Uint8Array;
  mime: string;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
}

export interface CrawlPolicyOptions {
  userAgent: string;
  httpFetch: HttpFetch;
  robotsFetch?: RobotsFetch;
  clock?: Clock;
  cache?: HttpCacheStore;
  scheduler?: Scheduler;
  circuit?: CircuitBreaker;
  random?: () => number;
  logger?: Logger;
  imageFetch?: ImageFetch;
  /** UAs explicitly disallowed (e.g. by Ripley robots) are rejected at startup. */
  disallowedUserAgents?: RegExp[];
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const DOC_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const IMAGE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

const CHALLENGE_MARKERS = [
  "captcha",
  "px-captcha",
  "cf-challenge",
  "just a moment",
  "access denied",
  "verify you are human",
  "unusual traffic",
];

function isChallenge(status: number, body: string): boolean {
  const lower = body.slice(0, 4000).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => lower.includes(m)) || status === 429 && lower.includes("captcha");
}

function honestUserAgent(ua: string): boolean {
  // An honest bot UA names itself and offers a contact/info URL.
  if (/mozilla\/5\.0.*(chrome|safari|firefox)/i.test(ua) && !/bot|spider|crawler/i.test(ua)) {
    return false; // browser-impersonating
  }
  return /\+https?:\/\//.test(ua) || /bot|crawler|spider/i.test(ua);
}

export class CrawlPolicy {
  readonly userAgent: string;
  private readonly httpFetch: HttpFetch;
  private readonly clock: Clock;
  private readonly cache: HttpCacheStore;
  private readonly scheduler: Scheduler;
  private readonly circuit: CircuitBreaker;
  private readonly robots: RobotsCache;
  private readonly random: () => number;
  private readonly imageFetch: ImageFetch;
  private readonly logger: Logger;

  constructor(options: CrawlPolicyOptions) {
    if (!options.userAgent || options.userAgent.trim().length === 0) {
      throw new PolicyError("SCRAP_USER_AGENT is required");
    }
    if (!honestUserAgent(options.userAgent)) {
      throw new PolicyError(
        "SCRAP_USER_AGENT must be an honest bot identity (name + contact URL), not a browser impersonation",
        { userAgent: options.userAgent },
      );
    }
    for (const re of options.disallowedUserAgents ?? []) {
      if (re.test(options.userAgent)) {
        throw new PolicyError("user agent is explicitly disallowed by robots", {
          userAgent: options.userAgent,
        });
      }
    }
    this.userAgent = options.userAgent;
    this.httpFetch = options.httpFetch;
    this.clock = options.clock ?? systemClock;
    this.cache = options.cache ?? new MemoryHttpCache();
    this.random = options.random ?? Math.random;
    this.circuit = options.circuit ?? new CircuitBreaker(this.clock);
    this.scheduler =
      options.scheduler ?? new Scheduler({ clock: this.clock, random: this.random });
    this.robots = new RobotsCache(
      options.robotsFetch ?? defaultRobotsFetch(this.httpFetch),
      this.clock,
    );
    this.imageFetch = options.imageFetch ?? defaultImageFetch();
    this.logger = options.logger ?? nullLogger;
  }

  get circuitBreaker(): CircuitBreaker {
    return this.circuit;
  }

  /**
   * Download an image under full policy control: allowlist/robots/circuit checks,
   * scheduling, redirect validation, `image/*` MIME enforcement, and a 10 MiB cap.
   */
  async fetchImage(rawUrl: string, options: { budget?: RequestBudget } = {}): Promise<PolicyImageResponse> {
    const u = await this.assertAllowed(rawUrl);
    const host = u.hostname;
    const startUrl = u.toString();
    options.budget?.consume();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.circuit.isOpen(host)) {
        throw new CircuitOpenError("circuit open for host", {
          host,
          cooldownMs: this.circuit.cooldownRemaining(host),
        });
      }
      const release = await this.scheduler.acquire(host, "image");
      try {
        let url = startUrl;
        let response: RawImageResponse | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          response = await this.imageFetch(url, {
            headers: { "user-agent": this.userAgent },
            redirect: "manual",
          });
          if (response.status >= 300 && response.status < 400 && response.headers["location"]) {
            if (hop === MAX_REDIRECTS) throw new PolicyError("too many redirects", { url });
            url = new URL(response.headers["location"], url).toString();
            this.assertNavigable(url);
            continue;
          }
          break;
        }
        if (!response) throw new PolicyError("no image response", { url });
        const mime = (response.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";


        if (RETRYABLE.has(response.status)) {
          const retryAfter = this.parseRetryAfter(response.headers["retry-after"]);
          if (retryAfter !== undefined) this.scheduler.penalize(host, retryAfter);
          if (attempt < MAX_ATTEMPTS) {
            await this.clock.sleep(retryAfter ?? this.backoff(attempt));
            continue;
          }
          // 429 (rate limiting) is expected on image CDNs — don't trip the circuit.
          if (response.status !== 429) this.circuit.recordFailure(host);
          throw new PolicyError(`image status ${response.status} after ${MAX_ATTEMPTS} attempts`, {
            url,
            status: response.status,
          });
        }

        if (response.status < 200 || response.status >= 300) {
          this.circuit.recordFailure(host);
          throw new PolicyError(`image status ${response.status}`, { url, status: response.status });
        }


        if (!mime.startsWith("image/")) {
          this.circuit.recordFailure(host);
          throw new PolicyError("non-image content type", { url, mime });
        }
        if (response.bytes.byteLength > 10 * 1024 * 1024) {
          this.circuit.recordFailure(host);
          throw new PolicyError("image exceeds 10 MiB", { url, size: response.bytes.byteLength });
        }
        this.circuit.recordSuccess(host);
        const digest = await crypto.subtle.digest("SHA-256", response.bytes);
        const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        return {
          url,
          status: response.status,
          bytes: response.bytes,
          mime,
          sha256,
          etag: response.headers["etag"] ?? null,
          lastModified: response.headers["last-modified"] ?? null,
        };
      } finally {
        release();
      }
    }
    throw new PolicyError("unreachable", { url: startUrl });
  }

  /** Synchronous structural checks for a URL (host/scheme/private/safety). */
  assertNavigable(rawUrl: string) {
    const u = parseUrlOrThrow(rawUrl);
    if (u.protocol !== "https:") {
      throw new PolicyError("only HTTPS URLs are allowed", { url: rawUrl });
    }
    if (FORBIDDEN_HOSTS[u.hostname]) {
      throw new PolicyError("host is explicitly forbidden", { host: u.hostname });
    }
    if (isPrivateHost(u.hostname)) {
      throw new PolicyError("private/local targets are not allowed", { host: u.hostname });
    }
    if (!isHostAllowed(u.hostname)) {
      throw new PolicyError("host is not on the allowlist", { host: u.hostname });
    }
    if (isSafetyFloorBlocked(u.hostname, u.pathname)) {
      throw new PolicyError("path is blocked by the safety floor", {
        host: u.hostname,
        path: u.pathname,
      });
    }
    return u;
  }

  /** Full admission check including robots. Throws PolicyError when denied. */
  async assertAllowed(rawUrl: string) {
    const u = this.assertNavigable(rawUrl);
    const allowed = await this.robots.isAllowed(u.toString(), this.userAgent);
    if (!allowed) {
      throw new PolicyError("blocked by robots.txt", { url: u.toString() });
    }
    return u;
  }

  private backoff(attempt: number): number {
    const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const jitter = base * 0.2 * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  private parseRetryAfter(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const secs = Number(value);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - this.clock.now());
    return undefined;
  }

  /** Run the full policy pipeline for a single resource. */
  async fetch(rawUrl: string, options: FetchOptions = {}): Promise<PolicyResponse> {
    const u = await this.assertAllowed(rawUrl);
    const host = u.hostname;
    const canonical = canonicalizeUrl(u.toString());
    const cls: RequestClass = options.class ?? (isImageHost(host) ? "image" : "document");

    if (this.circuit.isOpen(host)) {
      throw new CircuitOpenError("circuit open for host", {
        host,
        cooldownMs: this.circuit.cooldownRemaining(host),
      });
    }

    // Freshness floor: skip refetch entirely when still fresh.
    const cached = this.cache.get(canonical);
    if (cached && this.clock.now() < cached.freshUntil) {
      return {
        url: canonical,
        finalUrl: canonical,
        status: cached.status,
        headers: {},
        body: "",
        bodyHash: cached.bodyHash,
        etag: cached.etag,
        lastModified: cached.lastModified,
        fromCache: true,
        notModified: true,
      };
    }

    options.budget?.consume();

    const release = await this.scheduler.acquire(host, cls);
    try {
      return await this.attemptWithRetries(canonical, host, u.toString(), cls, cached, options);
    } finally {
      release();
    }
  }

  private async attemptWithRetries(
    canonical: string,
    host: string,
    startUrl: string,
    cls: RequestClass,
    cached: HttpCacheEntry | undefined,
    options: FetchOptions,
  ): Promise<PolicyResponse> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: RawResponse;
      let finalUrl: string;
      try {
        const followed = await this.follow(startUrl, cls, cached, options);
        response = followed.response;
        finalUrl = followed.finalUrl;
      } catch (err) {
        if (err instanceof PolicyError || err instanceof ChallengeDetectedError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_ATTEMPTS) {
          await this.clock.sleep(this.backoff(attempt));
          continue;
        }
        this.circuit.recordFailure(host);
        throw lastError;
      }

      if (isChallenge(response.status, response.body)) {
        this.circuit.tripImmediately(host);
        throw new ChallengeDetectedError("challenge/CAPTCHA detected", {
          host,
          status: response.status,
        });
      }


      if (response.status === 304 && cached) {
        const freshUntil = this.freshUntil(cls, response.headers, options.freshnessMs);
        this.cache.set({ ...cached, fetchedAt: this.clock.now(), freshUntil });
        this.circuit.recordSuccess(host);
        return {
          url: canonical,
          finalUrl,
          status: 304,
          headers: response.headers,
          body: "",
          bodyHash: cached.bodyHash,
          etag: cached.etag,
          lastModified: cached.lastModified,
          fromCache: true,
          notModified: true,
        };
      }

      if (response.status >= 200 && response.status < 300) {
        const bodyHash = await sha256Hex(response.body);
        this.cache.set({
          url: canonical,
          etag: response.headers["etag"] ?? null,
          lastModified: response.headers["last-modified"] ?? null,
          bodyHash,
          status: response.status,
          fetchedAt: this.clock.now(),
          freshUntil: this.freshUntil(cls, response.headers, options.freshnessMs),
        });
        this.circuit.recordSuccess(host);
        return {
          url: canonical,
          finalUrl,
          status: response.status,
          headers: response.headers,
          body: response.body,
          bodyHash,
          etag: response.headers["etag"] ?? null,
          lastModified: response.headers["last-modified"] ?? null,
          fromCache: false,
          notModified: false,
        };
      }

      if (RETRYABLE.has(response.status)) {
        const retryAfter = this.parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter !== undefined) this.scheduler.penalize(host, retryAfter);
        lastError = new PolicyError(`retryable status ${response.status}`, {
          status: response.status,
        });
        if (attempt < MAX_ATTEMPTS) {
          await this.clock.sleep(retryAfter ?? this.backoff(attempt));
          continue;
        }
        this.circuit.recordFailure(host);
        throw lastError;
      }

      // Non-retryable (e.g. 403/404): record failure and stop.
      this.circuit.recordFailure(host);
      throw new PolicyError(`non-retryable status ${response.status}`, {
        status: response.status,
        url: finalUrl,
      });
    }

    throw lastError ?? new PolicyError("exhausted retries");
  }

  /** Follow redirects manually (max 5), validating each hop against the allowlist. */
  private async follow(
    startUrl: string,
    cls: RequestClass,
    cached: HttpCacheEntry | undefined,
    options: FetchOptions,
  ): Promise<{ response: RawResponse; finalUrl: string }> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {
        "user-agent": this.userAgent,
        ...(options.headers ?? {}),
      };
      if (cached?.etag) headers["if-none-match"] = cached.etag;
      if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;

      const response = await this.httpFetch(url, {
        method: options.method ?? "GET",
        headers,
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400 && response.headers["location"]) {
        if (hop === MAX_REDIRECTS) {
          throw new PolicyError("too many redirects", { url: startUrl });
        }
        const next = new URL(response.headers["location"], url).toString();
        this.assertNavigable(next); // reject redirects leaving the allowlist
        url = next;
        continue;
      }
      return { response, finalUrl: url };
    }
    throw new PolicyError("redirect loop", { url: startUrl });
  }

  private freshUntil(
    cls: RequestClass,
    headers: Record<string, string>,
    override?: number,
  ): number {
    if (override !== undefined) return this.clock.now() + override;
    // If validators/freshness present, allow immediate revalidation next time.
    if (headers["etag"] || headers["last-modified"] || headers["cache-control"]) {
      return this.clock.now();
    }
    const floor = cls === "image" ? IMAGE_FRESHNESS_MS : DOC_FRESHNESS_MS;
    return this.clock.now() + floor;
  }
}

/** SHA-256 hex of a string body. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Adapt an HttpFetch into the RobotsFetch shape used by RobotsCache. */
function defaultRobotsFetch(httpFetch: HttpFetch): RobotsFetch {
  return async (url, init) => {
    const res = await httpFetch(url, { method: "GET", headers: init.headers, redirect: "manual" });
    return { status: res.status, body: res.body, location: res.headers["location"] };
  };
}

/** Parse an HTTPS URL or throw a PolicyError (inference avoids URL-type clashes). */
function parseUrlOrThrow(rawUrl: string) {
  try {
    return new URL(rawUrl);
  } catch {
    throw new PolicyError("invalid URL", { url: rawUrl });
  }
}

function headersToRecord(headers: { forEach(cb: (value: string, key: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Default text HttpFetch backed by the global fetch (manual redirects). */
export function defaultHttpFetch(): HttpFetch {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      redirect: "manual",
    });
    return { status: res.status, headers: headersToRecord(res.headers), body: await res.text() };
  };
}

/** Default binary ImageFetch backed by the global fetch (manual redirects). */
export function defaultImageFetch(): ImageFetch {
  return async (url, init) => {
    const res = await fetch(url, { headers: init.headers, redirect: "manual" });
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers: headersToRecord(res.headers), bytes: buf };
  };
}
