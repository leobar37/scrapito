/**
 * Security boundary tests: job/discovery/policy enforcement. These defend the
 * contracts that keep the HTTP API from becoming an arbitrary-code-execution
 * or SSRF surface, and keep CrawlPolicy the single choke point for outbound
 * navigation. No network access; everything runs against an in-memory SQLite
 * database and injected fakes.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../../src/config.ts";
import { createApp, ScrapeRunner } from "../../src/app/index.ts";
import { createServer } from "../../src/server/app.ts";
import { openPersistence } from "../../src/persistence/index.ts";
import { CrawlPolicy, type HttpFetch, type RawResponse } from "../../src/policy/crawl-policy.ts";
import { PolicyError } from "../../src/domain/errors.ts";
import { FakeClock } from "../../src/policy/clock.ts";
import { defineScraper } from "../../src/scrapers/define-scraper.ts";

const USER_AGENT = "ScrapMany/1.0 (+https://operator.example/bot-info)";
const API_KEY = "s3cr3t-test-key";

interface ErrorEnvelope {
  error: { code: string; message: string };
}

interface JobAcceptedEnvelope {
  jobId: number;
  status: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function testConfig(): AppConfig {
  return {
    dbPath: ":memory:",
    storageDir: "/tmp/scrap-many-security-test-storage",
    discoveryDir: "/tmp/scrap-many-security-test-discovery",
    userAgent: USER_AGENT,
    apiKey: API_KEY,
    host: "127.0.0.1",
    port: 0,
    agentBrowserBin: "agent-browser",
    agentBrowserTimeoutMs: 25_000,
    workerIdleTimeoutMs: 20_000,
  };
}

function buildServer() {
  const app = createApp(testConfig(), { migrate: true, requireMigrated: true });
  const server = createServer(app);
  return { app, server };
}

function throwingHttpFetch(): HttpFetch {
  return async (url) => {
    throw new Error(`network access is not allowed in this test: ${url}`);
  };
}

function buildPolicy(httpFetch: HttpFetch = throwingHttpFetch()): CrawlPolicy {
  return new CrawlPolicy({
    userAgent: USER_AGENT,
    httpFetch,
    clock: new FakeClock(0),
    random: () => 0.5,
  });
}

// ---------------------------------------------------------------------------
// POST /jobs/scrape — authentication and schema boundaries
// ---------------------------------------------------------------------------

describe("POST /jobs/scrape auth boundary", () => {
  const jobBody = () =>
    JSON.stringify({ scraperId: "fixture-products", maxRequests: 10, maxDurationMs: 30_000 });

  test("missing Authorization header is rejected with 401", async () => {
    const { server } = buildServer();
    const res = await server.request("/jobs/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jobBody(),
    });
    expect(res.status).toBe(401);
    const body = await readJson<ErrorEnvelope>(res);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("wrong Bearer token is rejected with 401", async () => {
    const { server } = buildServer();
    const res = await server.request("/jobs/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
      body: jobBody(),
    });
    expect(res.status).toBe(401);
    const body = await readJson<ErrorEnvelope>(res);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("valid Bearer token but unknown scraperId is rejected with 400 UNKNOWN_SCRAPER", async () => {
    const { app, server } = buildServer();
    const res = await server.request("/jobs/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${app.config.apiKey}` },
      body: JSON.stringify({
        scraperId: "evil-remote-module",
        maxRequests: 10,
        maxDurationMs: 30_000,
      }),
    });
    expect(res.status).toBe(400);
    const body = await readJson<ErrorEnvelope>(res);
    expect(body.error.code).toBe("UNKNOWN_SCRAPER");
  });

  test("extra fields (module path, source code, arbitrary URL) never reach the stored job", async () => {
    const { app, server } = buildServer();
    const res = await server.request("/jobs/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${app.config.apiKey}` },
      body: JSON.stringify({
        scraperId: "fixture-products",
        maxRequests: 10,
        maxDurationMs: 30_000,
        modulePath: "/etc/passwd",
        source: "require('node:child_process').execSync('id')",
        url: "https://evil.example.com/payload.js",
        script: "eval('1+1')",
      }),
    });
    // The route accepts the request (its own known fields are valid) but the
    // Zod schema strips every unrecognized key before it is ever persisted.
    expect(res.status).toBe(202);
    const { jobId } = await readJson<JobAcceptedEnvelope>(res);
    const jobRow = app.persistence.jobs.get(jobId);
    expect(jobRow).not.toBeNull();
    const storedParams: Record<string, unknown> = JSON.parse(jobRow?.params_json ?? "{}");
    for (const forbiddenKey of ["modulePath", "source", "url", "script"]) {
      expect(Object.hasOwn(storedParams, forbiddenKey)).toBe(false);
    }
    expect(storedParams.scraperId).toBe("fixture-products");
  });
});

// ---------------------------------------------------------------------------
// GET /images/:sha256 — path-traversal / injection boundary
// ---------------------------------------------------------------------------

describe("GET /images/:sha256 rejects malformed identifiers", () => {
  const badShas = [
    "abc",
    "g".repeat(64), // right length, invalid hex character
    "A".repeat(64), // right length, wrong case
    encodeURIComponent("../../../etc/passwd"),
    encodeURIComponent("' OR 1=1 --"),
  ];

  test.each(badShas)("rejects %s with 400", async (bad) => {
    const { server } = buildServer();
    const res = await server.request(`/images/${bad}`);
    expect(res.status).toBe(400);
    const body = await readJson<ErrorEnvelope>(res);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("a well-formed 64-hex sha256 passes validation (404, not 400, for an unknown image)", async () => {
    const { server } = buildServer();
    const res = await server.request(`/images/${"a".repeat(64)}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CrawlPolicy.assertNavigable — structural SSRF / host boundary
// ---------------------------------------------------------------------------

describe("CrawlPolicy.assertNavigable structural boundaries", () => {
  test("rejects non-HTTPS scheme", () => {
    const policy = buildPolicy();
    expect(() => policy.assertNavigable("http://simple.ripley.com.pe/")).toThrow(PolicyError);
  });

  test("rejects the forbidden legacy Ripley domain (robots disallow-all)", () => {
    const policy = buildPolicy();
    expect(() => policy.assertNavigable("https://www.ripley.com.pe/producto")).toThrow(PolicyError);
  });

  test("rejects a non-Peru / non-allowlisted host", () => {
    const policy = buildPolicy();
    expect(() => policy.assertNavigable("https://example.com/")).toThrow(PolicyError);
  });

  test.each([
    ["loopback", "https://127.0.0.1/"],
    ["private class A", "https://10.0.0.1/"],
    ["private class C", "https://192.168.1.1/"],
    ["link-local", "https://169.254.1.1/"],
  ])("rejects a private/local IP target (%s)", (_label, url) => {
    const policy = buildPolicy();
    expect(() => policy.assertNavigable(url)).toThrow(PolicyError);
  });

  test.each([
    ["Falabella checkout", "https://www.falabella.com.pe/falabella-pe/checkout"],
    ["Ripley recommendations API", "https://simple.ripley.com.pe/api/v2/recommendations/x"],
  ])("rejects a hard-coded safety-floor path (%s)", (_label, url) => {
    const policy = buildPolicy();
    expect(() => policy.assertNavigable(url)).toThrow(PolicyError);
  });

  test("still admits a normal allowlisted storefront URL (control case)", () => {
    const policy = buildPolicy();
    expect(() => policy.assertNavigable("https://simple.ripley.com.pe/producto/12345")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CrawlPolicy.fetch — redirect must not be able to leave the allowlist
// ---------------------------------------------------------------------------

describe("CrawlPolicy.fetch rejects redirects that leave the allowlist", () => {
  test("a 302 Location pointing off-allowlist throws PolicyError", async () => {
    const docUrl = "https://simple.ripley.com.pe/producto/redirect-test";
    const httpFetch: HttpFetch = async (url) => {
      if (url === "https://simple.ripley.com.pe/robots.txt") {
        const robotsAllow: RawResponse = { status: 200, headers: {}, body: "User-agent: *\nAllow: /" };
        return robotsAllow;
      }
      if (url === docUrl) {
        const redirectOffAllowlist: RawResponse = {
          status: 302,
          headers: { location: "https://evil.example.com/steal" },
          body: "",
        };
        return redirectOffAllowlist;
      }
      throw new Error(`unexpected fetch in redirect test: ${url}`);
    };
    const policy = buildPolicy(httpFetch);
    await expect(policy.fetch(docUrl)).rejects.toThrow(PolicyError);
  });

  test("a redirect that stays on an allowlisted host is followed successfully", async () => {
    const docUrl = "https://simple.ripley.com.pe/producto/redirect-ok";
    const finalUrl = "https://simple.ripley.com.pe/producto/redirect-ok-final";
    const httpFetch: HttpFetch = async (url) => {
      if (url === "https://simple.ripley.com.pe/robots.txt") {
        const robotsAllow: RawResponse = { status: 200, headers: {}, body: "User-agent: *\nAllow: /" };
        return robotsAllow;
      }
      if (url === docUrl) {
        const redirectOnAllowlist: RawResponse = { status: 302, headers: { location: finalUrl }, body: "" };
        return redirectOnAllowlist;
      }
      if (url === finalUrl) {
        const finalOk: RawResponse = { status: 200, headers: {}, body: "<html>ok</html>" };
        return finalOk;
      }
      throw new Error(`unexpected fetch in redirect test: ${url}`);
    };
    const policy = buildPolicy(httpFetch);
    const res = await policy.fetch(docUrl);
    expect(res.status).toBe(200);
    expect(res.body).toBe("<html>ok</html>");
  });
});

// ---------------------------------------------------------------------------
// ScrapeRunner — cross-store write boundary
// ---------------------------------------------------------------------------

const crossStoreScraper = defineScraper({
  id: "security-test-cross-store",
  store: "falabella-pe",
  version: 1,
  match: ["https://www.falabella.com.pe/"],
  paramsSchema: z.object({}).passthrough(),
  defaults: { downloadImages: false },
  async scrape(ctx) {
    // A falabella-pe scraper attempting to smuggle a ripley-pe product must
    // be rejected by the runner's save guard, not silently written.
    ctx.save.productSnapshot({
      store: "ripley-pe",
      externalId: "cross-store-sku",
      canonicalUrl: "https://simple.ripley.com.pe/product/cross-store-sku",
      name: "Cross-store smuggled product",
      price: { regularCents: 12_345 },
    });
  },
});

describe("ScrapeRunner cross-store write guard", () => {
  test("a product whose store differs from the scraper's declared store is rejected, not written", async () => {
    const persistence = openPersistence(":memory:", { migrate: true, requireMigrated: true });
    try {
      const runner = new ScrapeRunner({
        policy: buildPolicy(),
        catalog: persistence.catalog,
        runs: persistence.runs,
        clock: new FakeClock(0),
      });
      const outcome = await runner.run(crossStoreScraper, {}, {
        maxRequests: 5,
        maxDurationMs: 10_000,
      });
      expect(outcome.status).toBe("completed");
      expect(outcome.productsSaved).toBe(0);
      expect(outcome.productsRejected).toBe(1);
      expect(persistence.queries.stats().products).toBe(0);
    } finally {
      persistence.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Module graph — the HTTP server and scraper registry must never reach
// discovery-only code (BrowserTab.evaluate, snapshot, HAR capture, etc).
// ---------------------------------------------------------------------------

/** Recursively resolve local (relative) import/export specifiers, ignoring package imports. */
function collectLocalModuleGraph(entryAbsPath: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [entryAbsPath];
  const importRe = /(?:import|export)\s[\s\S]*?from\s+["']([^"']+)["']/g;

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue; // Unresolvable path is asserted on directly below.
    }

    importRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source))) {
      const spec = match[1];
      if (!spec || !spec.startsWith(".")) continue; // skip bare package specifiers (hono, zod, node:*)
      queue.push(resolve(dirname(current), spec));
    }
  }
  return visited;
}

describe("server and scraper registry module graph excludes discovery", () => {
  test("src/server/app.ts's full local import graph never touches src/discovery", () => {
    const entry = resolve(import.meta.dir, "../../src/server/app.ts");
    const graph = collectLocalModuleGraph(entry);
    expect(graph.size).toBeGreaterThan(1);
    for (const modulePath of graph) {
      expect(modulePath).not.toContain(`${sep}discovery${sep}`);
    }
  });

  test("src/scrapers/registry.ts's full local import graph never touches src/discovery", () => {
    const entry = resolve(import.meta.dir, "../../src/scrapers/registry.ts");
    const graph = collectLocalModuleGraph(entry);
    expect(graph.size).toBeGreaterThan(1);
    for (const modulePath of graph) {
      expect(modulePath).not.toContain(`${sep}discovery${sep}`);
    }
  });
});
