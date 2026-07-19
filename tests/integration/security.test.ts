/**
 * Security boundary tests: workspace isolation, discovery/policy enforcement.
 * These defend the contracts that keep the read-only API from ever reaching
 * writer/ingestion/browser code, keep ingestion's scraper registry isolated
 * from discovery-only code, and keep CrawlPolicy the single network choke
 * point. No real network access; everything runs against real (temp-file)
 * SQLite and injected fakes.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { openCatalogWriter } from "@scrapito/catalog/write";
import { openCatalogReader } from "@scrapito/catalog/read";
import {
  CrawlPolicy,
  type HttpFetch,
  type RawResponse,
} from "../../apps/ingest/src/policy/crawl-policy.ts";
import { PolicyError } from "@scrapito/contracts";
import { FakeClock } from "../../apps/ingest/src/policy/clock.ts";
import { ScrapeRunner } from "../../apps/ingest/src/app/scrape-runner.ts";
import { defineScraper } from "../../apps/ingest/src/scrapers/define-scraper.ts";
import { createServer } from "../../apps/api/src/app.ts";
import type { ApiConfig } from "../../apps/api/src/config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USER_AGENT = "ScrapMany/1.0 (+https://operator.example/bot-info)";
const ROOT = resolve(import.meta.dir, "..", "..");

interface ErrorEnvelope {
  error: { code: string; message: string };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scrapito-security-"));
  return join(dir, "test.sqlite");
}

async function buildReadonlyServer() {
  const dbPath = tmpDbPath();
  const writer = openCatalogWriter(dbPath, { migrate: true });
  writer.close();
  const reader = openCatalogReader(dbPath);
  const config: ApiConfig = {
    dbPath,
    storageDir: "/tmp/scrapito-security-test-storage",
    host: "127.0.0.1",
    port: 0,
    publicReads: false,
    webOrigins: ["https://web.example"],
  };
  const server = createServer(reader, config);
  return { server, reader, dbPath };
}

// ---------------------------------------------------------------------------
// Old mutation/job routes must be entirely gone from the read-only API.
// ---------------------------------------------------------------------------

describe("read-only API has no job/mutation surface", () => {
  test("every former job/mutation route returns 404, not an auth error", async () => {
    const { server, reader, dbPath } = await buildReadonlyServer();
    try {
      const routes: [string, string][] = [
        ["GET", "/jobs"],
        ["GET", "/jobs/1"],
        ["POST", "/jobs/scrape"],
        ["POST", "/jobs/1/cancel"],
        ["GET", "/scrapers"],
      ];
      for (const [method, path] of routes) {
        const res = await server.request(path, { method });
        expect(res.status).toBe(404);
      }
    } finally {
      reader.close();
      rmSync(dbPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GET /images/:sha256 — path-traversal / injection boundary
// ---------------------------------------------------------------------------

describe("GET /images/:sha256 rejects malformed identifiers", () => {
  const badShas = [
    "abc",
    "g".repeat(64),
    "A".repeat(64),
    encodeURIComponent("../../../etc/passwd"),
    encodeURIComponent("' OR 1=1 --"),
  ];

  test.each(badShas)("rejects %s with 400", async (bad) => {
    const { server, reader, dbPath } = await buildReadonlyServer();
    try {
      const res = await server.request(`/images/${bad}`);
      expect(res.status).toBe(400);
      const body = await readJson<ErrorEnvelope>(res);
      expect(body.error.code).toBe("BAD_REQUEST");
    } finally {
      reader.close();
      rmSync(dbPath, { force: true });
    }
  });

  test("a well-formed 64-hex sha256 passes validation (404, not 400, for an unknown image)", async () => {
    const { server, reader, dbPath } = await buildReadonlyServer();
    try {
      const res = await server.request(`/images/${"a".repeat(64)}`);
      expect(res.status).toBe(404);
    } finally {
      reader.close();
      rmSync(dbPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CORS — exact origin only, GET/HEAD/OPTIONS only
// ---------------------------------------------------------------------------

describe("API CORS is exact-origin, browser-only", () => {
  test("configured origin gets Access-Control-Allow-Origin; others are 403", async () => {
    const { server, reader, dbPath } = await buildReadonlyServer();
    try {
      const allowed = await server.request("/health", { headers: { Origin: "https://web.example" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://web.example");
      const denied = await server.request("/health", { headers: { Origin: "https://evil.example" } });
      expect(denied.status).toBe(403);
      const noOrigin = await server.request("/health");
      expect(noOrigin.status).toBe(200);
    } finally {
      reader.close();
      rmSync(dbPath, { force: true });
    }
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
        return { status: 200, headers: {}, body: "User-agent: *\nAllow: /" } satisfies RawResponse;
      }
      if (url === docUrl) {
        return {
          status: 302,
          headers: { location: "https://evil.example.com/steal" },
          body: "",
        } satisfies RawResponse;
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
        return { status: 200, headers: {}, body: "User-agent: *\nAllow: /" } satisfies RawResponse;
      }
      if (url === docUrl) {
        return { status: 302, headers: { location: finalUrl }, body: "" } satisfies RawResponse;
      }
      if (url === finalUrl) {
        return { status: 200, headers: {}, body: "<html>ok</html>" } satisfies RawResponse;
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
    const dbPath = tmpDbPath();
    const writer = openCatalogWriter(dbPath, { migrate: true });
    try {
      const runner = new ScrapeRunner({
        policy: buildPolicy(),
        catalog: writer.catalog,
        runs: writer.runs,
        clock: new FakeClock(0),
      });
      const outcome = await runner.run(crossStoreScraper, {}, { maxRequests: 5, maxDurationMs: 10_000 });
      expect(outcome.status).toBe("completed");
      expect(outcome.productsSaved).toBe(0);
      expect(outcome.productsRejected).toBe(1);
    } finally {
      writer.close();
      rmSync(dbPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Workspace-aware module graph walker.
//
// Resolves bare specifiers ONLY for packages that are actual root workspaces
// (apps/*, packages/*), strictly through their package.json#exports map:
//   - a bare specifier matching a workspace name resolves the "." export (or
//     fails if the package has none — e.g. @scrapito/catalog);
//   - a subpath specifier (e.g. "@scrapito/catalog/read") must match an exact
//     exports key or the walk FAILS (an unexported subpath is a boundary
//     violation, not silently skipped);
//   - any other bare specifier (hono, zod, node:*, agent-browser, ...) is an
//     EXTERNAL LEAF — never traversed, but its raw specifier IS recorded so
//     tests can assert a forbidden external package is never reachable.
//   - relative specifiers resolve normally and are traversed.
// ---------------------------------------------------------------------------

interface WorkspaceManifest {
  name: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string> | string;
}

interface WorkspaceEntry {
  dir: string;
  manifest: WorkspaceManifest;
}

function loadWorkspaceIndex(): Map<string, WorkspaceEntry> {
  const index = new Map<string, WorkspaceEntry>();
  for (const group of ["apps", "packages"]) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkspaceManifest;
      index.set(manifest.name, { dir, manifest });
    }
  }
  return index;
}

type ResolvedSpecifier =
  | { kind: "relative"; absPath: string }
  | { kind: "workspace"; absPath: string; pkgName: string }
  | { kind: "external"; specifier: string }
  | { kind: "invalid"; reason: string };

function resolveSpecifier(spec: string, fromFile: string, index: Map<string, WorkspaceEntry>): ResolvedSpecifier {
  if (spec.startsWith(".")) {
    return { kind: "relative", absPath: resolve(dirname(fromFile), spec) };
  }
  for (const [name, entry] of index) {
    if (spec !== name && !spec.startsWith(name + "/")) continue;
    const subpath = spec === name ? "." : "." + spec.slice(name.length);
    const exportsField = entry.manifest.exports;
    if (typeof exportsField === "string") {
      if (subpath !== ".") return { kind: "invalid", reason: `${name} has a single string export, cannot resolve ${subpath}` };
      return { kind: "workspace", absPath: resolve(entry.dir, exportsField), pkgName: name };
    }
    const target = exportsField?.[subpath];
    if (!target) {
      return { kind: "invalid", reason: `workspace package "${name}" does not export "${subpath}" via package.json#exports` };
    }
    return { kind: "workspace", absPath: resolve(entry.dir, target), pkgName: name };
  }
  return { kind: "external", specifier: spec };
}

interface ModuleGraph {
  /** Absolute paths of every workspace-internal file reached (relative + resolved workspace exports). */
  files: Set<string>;
  /** Bare external/workspace specifiers seen at the import site (e.g. "hono", "@scrapito/catalog/write"). */
  specifiers: Set<string>;
  /** Workspace package names actually entered via their exports map. */
  workspacePackagesEntered: Set<string>;
}

const IMPORT_RE = /(?:import|export)\s[\s\S]*?from\s+["']([^"']+)["']/g;

function collectModuleGraph(entryAbsPath: string, index: Map<string, WorkspaceEntry>): ModuleGraph {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const workspacePackagesEntered = new Set<string>();
  const queue: string[] = [entryAbsPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);

    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }

    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source))) {
      const spec = match[1];
      if (!spec) continue;
      const resolved = resolveSpecifier(spec, current, index);
      if (resolved.kind === "relative") {
        queue.push(resolved.absPath);
      } else if (resolved.kind === "workspace") {
        specifiers.add(spec);
        workspacePackagesEntered.add(resolved.pkgName);
        queue.push(resolved.absPath);
      } else if (resolved.kind === "external") {
        specifiers.add(spec);
        // external leaf — never traversed.
      } else {
        throw new Error(`module graph violation: ${current} imports "${spec}" — ${resolved.reason}`);
      }
    }
  }
  return { files, specifiers, workspacePackagesEntered };
}

describe("workspace module graph boundaries", () => {
  const index = loadWorkspaceIndex();

  test("workspace index discovers every expected package", () => {
    expect([...index.keys()].sort()).toEqual(
      ["@scrapito/agent", "@scrapito/api", "@scrapito/catalog", "@scrapito/contracts", "@scrapito/ingest", "@scrapito/web"].sort(),
    );
  });

  test("resolving an unexported workspace subpath is a violation, not a silent skip", () => {
    const resolved = resolveSpecifier("@scrapito/catalog", join(ROOT, "apps/api/src/app.ts"), index);
    expect(resolved.kind).toBe("invalid");
    const resolvedDeep = resolveSpecifier(
      "@scrapito/catalog/write/catalog-store",
      join(ROOT, "apps/api/src/app.ts"),
      index,
    );
    expect(resolvedDeep.kind).toBe("invalid");
  });

  test("apps/api's full module graph never reaches the writer, ingestion, browser, discovery, runner, or scraper registry", () => {
    const entry = join(ROOT, "apps/api/src/index.ts");
    const graph = collectModuleGraph(entry, index);
    expect(graph.files.size).toBeGreaterThan(1);
    for (const f of graph.files) {
      expect(f).not.toContain(`${sep}apps${sep}ingest${sep}`);
      expect(f).not.toContain(`${sep}catalog${sep}src${sep}write${sep}`);
      expect(f).not.toContain(`${sep}discovery${sep}`);
      expect(f).not.toContain(`${sep}apps${sep}agent${sep}`);
      expect(f).not.toContain(`${sep}.omp${sep}`);
    }
    for (const spec of graph.specifiers) {
      expect(spec).not.toBe("@scrapito/ingest");
      expect(spec).not.toBe("@scrapito/catalog/write");
      expect(spec).not.toBe("agent-browser");
      expect(spec).not.toBe("commander");
      expect(spec).not.toBe("robots-parser");
      expect(spec).not.toBe("@scrapito/agent");
      expect(spec.toLowerCase()).not.toContain("discord");
      expect(spec.toLowerCase()).not.toContain("webhook");
    }
  });

  test("apps/api package.json dependencies never include ingestion-only packages", () => {
    const manifest = index.get("@scrapito/api")!.manifest;
    const deps = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of ["@scrapito/ingest", "@scrapito/agent", "agent-browser", "commander", "robots-parser", "discord"]) {
      expect(deps).not.toContain(forbidden);
    }
    expect(deps).toContain("@scrapito/contracts");
    expect(deps).toContain("@scrapito/catalog");
  });

  test("apps/web's full module graph never reaches catalog or ingestion", () => {
    const webEntryCandidates = [
      join(ROOT, "apps/web/src/router.tsx"),
      join(ROOT, "apps/web/src/router.ts"),
    ];
    const entry = webEntryCandidates.find((p) => existsSync(p));
    if (!entry) return; // web app not yet scaffolded in this checkout.
    const graph = collectModuleGraph(entry, index);
    for (const f of graph.files) {
      expect(f).not.toContain(`${sep}apps${sep}ingest${sep}`);
      expect(f).not.toContain(`${sep}packages${sep}catalog${sep}`);
    }
    for (const spec of graph.specifiers) {
      expect(spec.startsWith("@scrapito/catalog")).toBe(false);
      expect(spec).not.toBe("@scrapito/ingest");
    }
  });

  test("apps/web package.json dependencies never include catalog or ingestion", () => {
    const manifest = index.get("@scrapito/web")?.manifest;
    if (!manifest) return;
    const deps = Object.keys(manifest.dependencies ?? {});
    expect(deps).not.toContain("@scrapito/catalog");
    expect(deps).not.toContain("@scrapito/ingest");
  });

  test("ingest's scraper registry never reaches discovery-only code", () => {
    const entry = join(ROOT, "apps/ingest/src/scrapers/registry.ts");
    const graph = collectModuleGraph(entry, index);
    expect(graph.files.size).toBeGreaterThan(1);
    for (const f of graph.files) {
      expect(f).not.toContain(`${sep}discovery${sep}`);
    }
  });
});
