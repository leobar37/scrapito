/**
 * Robots.txt fetching, parsing (RFC 9309 longest-match via robots-parser),
 * and 24-hour caching. Fails closed on network/5xx/unreachable; on a 4xx
 * "unavailable" response, robots is treated as permissive (the caller still
 * applies the hard-coded safety floor).
 */
import robotsParser from "robots-parser";
import type { Clock } from "./clock.ts";

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;

export type RobotsFetch = (
  url: string,
  init: { redirect: "manual"; headers: Record<string, string> },
) => Promise<{ status: number; body: string; location?: string }>;

interface RobotsMatcher {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

interface RobotsEntry {
  /** null means fail-closed (deny all). */
  matcher: RobotsMatcher | null;
  fetchedAt: number;
  /** true when robots was unavailable (4xx) -> permissive. */
  permissive: boolean;
}

export class RobotsCache {
  private readonly cache = new Map<string, RobotsEntry>();

  constructor(
    private readonly fetchImpl: RobotsFetch,
    private readonly clock: Clock,
  ) {}

  private async load(host: string, userAgent: string): Promise<RobotsEntry> {
    const cached = this.cache.get(host);
    if (cached && this.clock.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
      return cached;
    }
    const robotsUrl = `https://${host}/robots.txt`;
    let entry: RobotsEntry;
    try {
      let url = robotsUrl;
      let status = 0;
      let body = "";
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await this.fetchImpl(url, {
          redirect: "manual",
          headers: { "user-agent": userAgent, accept: "text/plain" },
        });
        status = res.status;
        body = res.body;
        if (status >= 300 && status < 400 && res.location) {
          if (hop === MAX_REDIRECTS) {
            entry = { matcher: null, fetchedAt: this.clock.now(), permissive: false };
            this.cache.set(host, entry);
            return entry;
          }
          url = new URL(res.location, url).toString();
          continue;
        }
        break;
      }
      if (status >= 200 && status < 300) {
        entry = {
          matcher: robotsParser(robotsUrl, body),
          fetchedAt: this.clock.now(),
          permissive: false,
        };
      } else if (status >= 400 && status < 500) {
        // Unavailable -> permissive, safety floor still applies upstream.
        entry = { matcher: null, fetchedAt: this.clock.now(), permissive: true };
      } else {
        // 5xx / unexpected -> fail closed.
        entry = { matcher: null, fetchedAt: this.clock.now(), permissive: false };
      }
    } catch {
      // Network/unreachable -> fail closed.
      entry = { matcher: null, fetchedAt: this.clock.now(), permissive: false };
    }
    this.cache.set(host, entry);
    return entry;
  }

  /** Returns true if the URL is allowed by robots for this UA. */
  async isAllowed(url: string, userAgent: string): Promise<boolean> {
    const u = new URL(url);
    const entry = await this.load(u.hostname, userAgent);
    if (entry.permissive) return true;
    if (!entry.matcher) return false; // fail closed
    const allowed = entry.matcher.isAllowed(url, userAgent);
    return allowed !== false;
  }

  /** Test/introspection helper. */
  peek(host: string): RobotsEntry | undefined {
    return this.cache.get(host);
  }
}
