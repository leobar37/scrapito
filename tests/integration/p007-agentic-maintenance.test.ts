import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  InvocationContextSchema,
  InvocationResultSchema,
  type CapabilityId,
  type InvocationContext,
  type InvocationResult,
  type ProductInput,
  type SiteDefinition,
  type StoreId,
  type StrategyId,
} from "@scrapito/contracts";
import {
  openCatalogWriter,
  type CatalogWriter,
} from "@scrapito/catalog/write";
import { CatalogQueries } from "@scrapito/catalog/read";
import { composeInvocation } from "../../apps/agent/src/composition.ts";
import { LifecycleRepairInvocationExecutor } from "../../apps/agent/src/capabilities/repair.ts";
import { WriteGate } from "../../apps/agent/src/gates.ts";
import { invokeOneShot } from "../../apps/agent/src/invocation.ts";
import {
  assertCandidateIntegrity,
  hashRepairValue,
  runRepairLifecycle,
} from "../../apps/agent/src/repair/lifecycle.ts";
import {
  assertApprovalCurrent,
  createHumanApproval,
  promoteApprovedRepair,
} from "../../apps/agent/src/repair/promotion.ts";
import type {
  PromotionSnapshot,
  RepairCandidate,
  RepairChange,
  RepairCheck,
  RepairDiff,
  RepairLifecycleHost,
  RepairPlanner,
  RepairPromotionHost,
  RepairWorkspace,
} from "../../apps/agent/src/repair/types.ts";
import type {
  AgentConfig,
  AgentSessionRunner,
  IngestExecutor,
  RepairInvocationExecutor,
  SessionRunInput,
  SessionRunOutput,
} from "../../apps/agent/src/types.ts";
import { ScrapeRunner } from "../../apps/ingest/src/app/scrape-runner.ts";
import { CrawlPolicy, type HttpFetch } from "../../apps/ingest/src/policy/crawl-policy.ts";
import { FakeClock } from "../../apps/ingest/src/policy/clock.ts";
import { ALLOW_ALL_ROBOTS } from "../../apps/ingest/src/policy/testkit.ts";
import { getScraper } from "../../apps/ingest/src/scrapers/registry.ts";
import {
  adaptTargetInvocation,
  CAPABILITY_SUPPORT_MATRIX,
  SITE_DEFINITIONS,
} from "../../apps/ingest/src/targets/definitions.ts";

const ROOT = join(import.meta.dir, "../..");
const HONEST_USER_AGENT = "ScrapMany/1.0 (+https://operator.example/bot-info)";
const BASE_COMMIT = "a".repeat(40);
const REPAIR_BASELINE_CONTENT = "export const normalized = false;\n";
const REPAIR_CANDIDATE_CONTENT = "export const normalized = true;\n";
const REPAIR_EVIDENCE_CONTENT = "checked-in deterministic fixture";
const BASELINE_TREE = hashRepairValue(REPAIR_BASELINE_CONTENT);
const RUN_SHA = hashRepairValue("p007-run");
const EVIDENCE_SHA = hashRepairValue(REPAIR_EVIDENCE_CONTENT);
const FAILURE_SHA = hashRepairValue("p007-reproduced-parser-failure");

const CONFIG: AgentConfig = {
  models: {
    coordinator: "fake/coordinator",
    siteAgent: "fake/site-agent",
    repairAgent: "fake/repair-agent",
    verifier: "fake/verifier",
  },
  caps: {
    maxConcurrency: 3,
    maxDepth: 2,
    maxRuntimeMs: 10_000,
    maxLlmRequests: 16,
    maxCostUsd: 0.5,
    maxInputTokens: 200_000,
    maxOutputTokens: 40_000,
  },
};

const FIXTURE_BY_SITE: Record<StoreId, { path: string; evidenceId: string; contentType: string }> = {
  "ripley-pe": {
    path: "apps/ingest/src/scrapers/ripley-pe/__fixtures__/list.html",
    evidenceId: "ripley-pe/__fixtures__/list.html",
    contentType: "text/html; charset=utf-8",
  },
  "falabella-pe": {
    path: "apps/ingest/src/scrapers/falabella-pe/__fixtures__/list.html",
    evidenceId: "falabella-pe/__fixtures__/list.html",
    contentType: "text/html; charset=utf-8",
  },
  "promart-pe": {
    path: "apps/ingest/src/scrapers/promart-pe/__fixtures__/search-refrigeracion.json",
    evidenceId: "promart-pe/__fixtures__/search-refrigeracion.json",
    contentType: "application/json",
  },
  "oechsle-pe": {
    path: "apps/ingest/src/scrapers/oechsle-pe/__fixtures__/search-televisores.json",
    evidenceId: "oechsle-pe/__fixtures__/search-televisores.json",
    contentType: "application/json",
  },
};
const WORKTREE_REGISTRY_BY_SCRAPER = Object.fromEntries(
  SITE_DEFINITIONS.map((site) => [site.scraperId, site.repairRoots[0]]),
) as Record<string, string>;
const WORKTREE_REGISTRY_CONTENT =
  `export const STATIC_SCRAPER_REGISTRY = ${JSON.stringify(WORKTREE_REGISTRY_BY_SCRAPER, null, 2)} as const;\n`;

function targetFor(strategy: StrategyId): InvocationContext["target"] {
  switch (strategy) {
    case "homepage":
      return { kind: "homepage" };
    case "trending":
      return { kind: "trending" };
    case "category":
      return { kind: "category", externalId: "fixture-category" };
    case "product":
      return { kind: "product", externalId: "fixture-product" };
    case "search":
      return { kind: "search", query: "fixture search" };
  }
}

function manifest(
  site: StoreId,
  strategy: StrategyId,
  intent: CapabilityId,
  suffix = "default",
): InvocationContext {
  const raw = {
    schemaVersion: 1,
    invocationId: `p007-${site}-${strategy}-${intent}-${suffix}`,
    intent,
    site,
    strategy,
    target: targetFor(strategy),
    constraints: { maxRequests: 5, maxDurationMs: 2_000, pages: 1, downloadImages: false },
    ...(intent === "repair"
      ? {
          repairPolicy: {
            allowRepair: true,
            reproduction: {
              runRef: `fixture:${site}:${strategy}`,
              runSha256: RUN_SHA,
              evidenceId: FIXTURE_BY_SITE[site].evidenceId,
              evidenceSha256: EVIDENCE_SHA,
              expectedFailureSha256: FAILURE_SHA,
              baselineCommit: BASE_COMMIT,
              baselineTreeSha256: BASELINE_TREE,
            },
          },
        }
      : {}),
  };
  return InvocationContextSchema.parse(raw);
}
function expectedFixtureUrl(invocation: InvocationContext): string {
  const value = invocation.target.kind === "category"
    ? invocation.target.externalId
    : invocation.target.kind === "search"
      ? invocation.target.query
      : (() => {
          throw new Error(`no fixture route for ${invocation.target.kind}`);
        })();
  const encoded = encodeURIComponent(value);
  if (invocation.site === "ripley-pe") {
    return invocation.strategy === "category"
      ? `https://simple.ripley.com.pe/${value}?page=1`
      : `https://simple.ripley.com.pe/search/${encoded}?page=1`;
  }
  if (invocation.site === "falabella-pe") {
    return invocation.strategy === "category"
      ? `https://www.falabella.com.pe/falabella-pe/category/${value}?page=1`
      : `https://www.falabella.com.pe/falabella-pe/search?Ntt=${encoded}&page=1`;
  }
  if (invocation.site === "oechsle-pe") {
    return `https://www.oechsle.pe/api/catalog_system/pub/products/search/${encoded}?_from=0&_to=49`;
  }
  return `https://www.promart.pe/api/catalog_system/pub/products/search/${encoded}?_from=0&_to=49`;
}

class ParallelDeterministicSession implements AgentSessionRunner {
  active = 0;
  maxObserved = 0;
  calls = 0;
  readonly #barrier: Promise<void>;
  #releaseBarrier!: () => void;

  constructor(private readonly expectedCalls = 1) {
    this.#barrier = new Promise<void>((resolve) => {
      this.#releaseBarrier = resolve;
    });
  }

  async run(input: SessionRunInput): Promise<SessionRunOutput> {
    this.calls += 1;
    this.active += 1;
    this.maxObserved = Math.max(this.maxObserved, this.active);
    if (this.calls === this.expectedCalls) this.#releaseBarrier();
    try {
      await this.#barrier;
      if (input.signal.aborted) throw input.signal.reason;
      return {
        decision: {
          action: "ingest",
          summary: "fixture-backed deterministic acquire",
          evidenceIds: [...input.composition.evidence],
          actionId: `fake-${input.composition.invocation.invocationId}`,
        },
        usage: { requests: 1, inputTokens: 100, outputTokens: 25, costUsd: 0.001 },
        modelsUsed: ["fake/deterministic"],
      };
    } finally {
      this.active -= 1;
    }
  }
}

class FixtureCatalogExecutor implements IngestExecutor {
  calls = 0;
  active = 0;
  maxObserved = 0;
  readonly requestedUrls: string[] = [];

  constructor(private readonly writer: CatalogWriter) {}

  async execute(invocation: InvocationContext, signal: AbortSignal): Promise<InvocationResult> {
    if (signal.aborted) throw signal.reason;
    this.calls += 1;
    this.active += 1;
    this.maxObserved = Math.max(this.maxObserved, this.active);
    const started = performance.now();
    try {
      const adapted = adaptTargetInvocation(invocation);
      const scraper = getScraper(adapted.scraperId);
      if (!scraper) throw new Error(`missing static scraper ${adapted.scraperId}`);
      const fixture = FIXTURE_BY_SITE[invocation.site];
      const expectedUrl = expectedFixtureUrl(invocation);
      const expectedHost = adapted.site.hosts[0];
      const httpFetch: HttpFetch = async (url, init) => {
        const parsed = new URL(url);
        if (url !== expectedUrl || parsed.hostname !== expectedHost || init.method !== "GET") {
          throw new Error(`unexpected fixture HTTP route: ${init.method} ${url}; expected GET ${expectedUrl}`);
        }
        this.requestedUrls.push(url);
        return {
          status: 200,
          headers: { "content-type": fixture.contentType },
          body: readFileSync(join(ROOT, fixture.path), "utf8"),
        };
      };
      const clock = new FakeClock(0);
      const runner = new ScrapeRunner({
        policy: new CrawlPolicy({
          userAgent: HONEST_USER_AGENT,
          httpFetch,
          robotsFetch: ALLOW_ALL_ROBOTS,
          clock,
          random: () => 0.5,
        }),
        catalog: this.writer.catalog,
        runs: this.writer.runs,
        clock,
      });
      const outcome = await runner.run(scraper, adapted.params, adapted.runOptions);
      const durationMs = Math.max(1, Math.ceil(performance.now() - started));
      return InvocationResultSchema.parse({
        schemaVersion: 1,
        invocationId: invocation.invocationId,
        status: outcome.status,
        site: invocation.site,
        strategy: invocation.strategy,
        capability: invocation.intent,
        run: {
          runId: outcome.runId,
          scraperId: adapted.scraperId,
          status: outcome.status,
          startedAt: outcome.startedAt,
          finishedAt: outcome.finishedAt,
        },
        coverage: outcome.coverageId == null
          ? null
          : {
              coverageId: outcome.coverageId,
              status: outcome.coverageStatus,
              authoritative: outcome.coverageAuthoritative,
              boundary: outcome.coverageBoundary,
              requests: outcome.requestsMade,
              productsSeen: outcome.productsSeen,
              duplicatesSeen: outcome.duplicatesSeen,
              productsRejected: outcome.productsRejected,
              stopReason: outcome.coverageStopReason,
            },
        artifacts: [{ kind: "fixture_ingest", ref: `fixture:${fixture.path}`, sha256: null }],
        usage: {
          requests: outcome.requestsMade,
          durationMs,
          writerDurationMs: outcome.writerDurationMs,
          productsSaved: outcome.productsSaved,
          productsSeen: outcome.productsSeen,
          productsRejected: outcome.productsRejected,
          duplicatesSeen: outcome.duplicatesSeen,
          imagesDownloaded: outcome.imagesDownloaded,
          llm: null,
        },
        error: outcome.status === "failed"
          ? { code: "FIXTURE_INGEST_FAILED", message: outcome.error ?? "fixture ingest failed" }
          : null,
      });
    } finally {
      this.active -= 1;
    }
  }
}

class TempRepairHost implements RepairLifecycleHost {
  readonly workspaceRoots: string[] = [];
  readonly canaryScrapers: string[] = [];
  readonly canaryHashes: string[] = [];
  private readonly sitesByWorkspace = new Map<string, SiteDefinition>();
  private readonly changesByWorkspace = new Map<string, readonly RepairChange[]>();

  constructor(readonly tempRoot: string) {}

  private path(workspace: RepairWorkspace, relativePath: string): string {
    const materialized = join(workspace.root, relativePath);
    if (!materialized.startsWith(`${workspace.root}/`)) throw new Error(`path escaped temp worktree: ${relativePath}`);
    return materialized;
  }

  private write(workspace: RepairWorkspace, relativePath: string, content: string): void {
    const path = this.path(workspace, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  async createWorktree(input: {
    invocationId: string;
    site: SiteDefinition;
    expectedCommit: string;
    expectedTreeSha256: string;
  }): Promise<RepairWorkspace> {
    const root = join(this.tempRoot, input.invocationId);
    mkdirSync(root, { recursive: true });
    const workspace = {
      id: input.invocationId,
      root,
      baseCommit: input.expectedCommit,
      baselineTreeSha256: input.expectedTreeSha256,
    };
    this.workspaceRoots.push(root);
    this.sitesByWorkspace.set(workspace.id, input.site);
    const repairRoot = input.site.repairRoots[0]!;
    this.write(workspace, `${repairRoot}/products.ts`, "export const fixture = true;\n");
    this.write(workspace, `${repairRoot}/normalize.ts`, REPAIR_BASELINE_CONTENT);
    this.write(
      workspace,
      `apps/ingest/src/scrapers/${FIXTURE_BY_SITE[input.site.site].evidenceId}`,
      REPAIR_EVIDENCE_CONTENT,
    );
    this.write(workspace, "apps/ingest/src/scrapers/registry.ts", WORKTREE_REGISTRY_CONTENT);
    if (hashRepairValue(readFileSync(this.path(workspace, `${repairRoot}/normalize.ts`), "utf8")) !== input.expectedTreeSha256) {
      throw new Error("materialized worktree baseline hash mismatch");
    }
    return workspace;
  }

  async readAllowedSources(workspace: RepairWorkspace, repairRoot: string) {
    const site = this.sitesByWorkspace.get(workspace.id);
    if (!site || site.repairRoots[0] !== repairRoot) throw new Error("workspace/site scope mismatch");
    const paths = [
      `${repairRoot}/products.ts`,
      `${repairRoot}/normalize.ts`,
      `apps/ingest/src/scrapers/${FIXTURE_BY_SITE[site.site].evidenceId}`,
    ];
    return paths.map((path) => {
      const content = readFileSync(this.path(workspace, path), "utf8");
      return { path, content, sha256: hashRepairValue(content) };
    });
  }

  async reproduce(workspace: RepairWorkspace): Promise<RepairCheck> {
    const site = this.sitesByWorkspace.get(workspace.id);
    const normalizePath = `${site?.repairRoots[0]}/normalize.ts`;
    const reproduced = readFileSync(this.path(workspace, normalizePath), "utf8") === REPAIR_BASELINE_CONTENT;
    return {
      ok: false,
      kind: "parser",
      sha256: reproduced ? FAILURE_SHA : hashRepairValue("unexpected-baseline"),
      detail: "materialized fixture parser failure reproduced",
    };
  }

  async applyChanges(workspace: RepairWorkspace, changes: readonly RepairChange[]): Promise<void> {
    for (const change of changes) this.write(workspace, change.path, change.content);
    this.changesByWorkspace.set(workspace.id, [...changes]);
  }

  async diff(workspace: RepairWorkspace): Promise<RepairDiff> {
    const changes = this.changesByWorkspace.get(workspace.id) ?? [];
    const materialized = changes.map((change) => ({
      path: change.path,
      content: readFileSync(this.path(workspace, change.path), "utf8"),
    }));
    const text = materialized.map((change) => `${change.path}\n${change.content}`).join("\n");
    return {
      text,
      files: materialized.map((change) => change.path),
      sha256: hashRepairValue(text),
      fixturesSha256: hashRepairValue(
        readFileSync(
          this.path(
            workspace,
            `apps/ingest/src/scrapers/${FIXTURE_BY_SITE[this.sitesByWorkspace.get(workspace.id)!.site].evidenceId}`,
          ),
          "utf8",
        ),
      ),
    };
  }

  async verifyOffline(workspace: RepairWorkspace, scraperId: string): Promise<RepairCheck> {
    const repairRoot = WORKTREE_REGISTRY_BY_SCRAPER[scraperId];
    const candidatePath = `${repairRoot}/normalize.ts`;
    const content = readFileSync(this.path(workspace, candidatePath), "utf8");
    const ok = content === REPAIR_CANDIDATE_CONTENT;
    return {
      ok,
      kind: ok ? "ok" : "normalization",
      sha256: hashRepairValue({ scraperId, candidatePath, content }),
      detail: "fixed offline validation read the materialized candidate",
    };
  }

  async canary(workspace: RepairWorkspace, scraperId: string): Promise<RepairCheck> {
    const registryPath = this.path(workspace, "apps/ingest/src/scrapers/registry.ts");
    const registryContent = readFileSync(registryPath, "utf8");
    const repairRoot = WORKTREE_REGISTRY_BY_SCRAPER[scraperId];
    const candidatePath = `${repairRoot}/normalize.ts`;
    const candidateContent = readFileSync(this.path(workspace, candidatePath), "utf8");
    const registrySha256 = hashRepairValue(registryContent);
    const candidateSha256 = hashRepairValue(candidateContent);
    const ok =
      registryContent === WORKTREE_REGISTRY_CONTENT &&
      repairRoot === this.sitesByWorkspace.get(workspace.id)?.repairRoots[0] &&
      candidateContent === REPAIR_CANDIDATE_CONTENT;
    const sha256 = hashRepairValue({ scraperId, repairRoot, registrySha256, candidateSha256 });
    this.canaryScrapers.push(scraperId);
    this.canaryHashes.push(sha256);
    return {
      ok,
      kind: ok ? "ok" : "fixture",
      sha256,
      detail: `materialized static registry selected candidate ${candidateSha256}`,
    };
  }
}

const repairPlanner: RepairPlanner = {
  async propose({ site }) {
    return [{ path: `${site.repairRoots[0]}/normalize.ts`, content: REPAIR_CANDIDATE_CONTENT }];
  },
};

class FailingCanaryPromotionHost implements RepairPromotionHost {
  rollbackCalls = 0;
  active = 0;
  maxObserved = 0;
  readonly firstApplyStarted: Promise<void>;
  readonly #holdApply: Promise<void>;
  #signalApplyStarted!: () => void;
  #releaseApply!: () => void;
  readonly #productionRoot: string;
  readonly #repairRoot: string;

  constructor(tempRoot: string, repairRoot: string) {
    this.#productionRoot = join(tempRoot, "production");
    this.#repairRoot = repairRoot;
    this.firstApplyStarted = new Promise<void>((resolve) => {
      this.#signalApplyStarted = resolve;
    });
    this.#holdApply = new Promise<void>((resolve) => {
      this.#releaseApply = resolve;
    });
    const baselinePath = this.path(`${repairRoot}/normalize.ts`);
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, REPAIR_BASELINE_CONTENT);
  }

  private path(relativePath: string): string {
    const materialized = join(this.#productionRoot, relativePath);
    if (!materialized.startsWith(`${this.#productionRoot}/`)) throw new Error(`promotion path escaped temp root: ${relativePath}`);
    return materialized;
  }

  get treeSha256(): string {
    return hashRepairValue(readFileSync(this.path(`${this.#repairRoot}/normalize.ts`), "utf8"));
  }

  releaseApply(): void {
    this.#releaseApply();
  }

  async capture(repairRoot: string, changedFiles: readonly string[]): Promise<PromotionSnapshot> {
    if (repairRoot !== this.#repairRoot || changedFiles.length !== 1) throw new Error("unexpected promotion scope");
    const files = Object.fromEntries(
      changedFiles.map((path) => [path, readFileSync(this.path(path), "utf8")]),
    );
    return { treeSha256: hashRepairValue(files[changedFiles[0]!]), opaque: files };
  }

  async apply(changes: readonly RepairChange[]): Promise<void> {
    this.active += 1;
    this.maxObserved = Math.max(this.maxObserved, this.active);
    try {
      for (const change of changes) {
        const path = this.path(change.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, change.content);
      }
      this.#signalApplyStarted();
      await this.#holdApply;
    } finally {
      this.active -= 1;
    }
  }

  async productionCanary(scraperId: string): Promise<RepairCheck> {
    const content = readFileSync(this.path(`${this.#repairRoot}/normalize.ts`), "utf8");
    return {
      ok: false,
      kind: "fixture",
      sha256: hashRepairValue({ scraperId, content }),
      detail: content === REPAIR_CANDIDATE_CONTENT
        ? "controlled canary failure after materialized promotion"
        : "promotion did not materialize candidate",
    };
  }

  async rollback(snapshot: PromotionSnapshot): Promise<void> {
    const files = snapshot.opaque as Record<string, string>;
    for (const [path, content] of Object.entries(files)) writeFileSync(this.path(path), content);
    this.rollbackCalls += 1;
  }

  async currentTreeSha256(repairRoot: string): Promise<string> {
    if (repairRoot !== this.#repairRoot) throw new Error("unexpected repair root");
    return this.treeSha256;
  }
}


async function drainMicrotasks(ticks = 10): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

function sqliteCount(writer: CatalogWriter, table: string): number {
  const allowed: Record<string, true> = {
    scraper_runs: true,
    target_coverages: true,
    products: true,
    price_observations: true,
    product_sightings: true,
  };
  if (!allowed[table]) throw new Error(`unexpected table ${table}`);
  return writer.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
}
function linkedProduct(invocationId: string, price: ProductInput["price"]): ProductInput {
  return {
    store: "ripley-pe",
    externalId: `${invocationId}-history`,
    canonicalUrl: `https://simple.ripley.com.pe/${invocationId}-history`,
    name: "Invocation-linked P007 history",
    description: null,
    brand: null,
    sponsored: false,
    attributes: {},
    categories: [],
    images: [],
    price,
    variants: [],
    variantsObserved: true,
  };
}

function startLinkedCoverage(writer: CatalogWriter, invocationId: string, suffix: string) {
  const runId = writer.runs.start(`p007-proof:${invocationId}:${suffix}`, "ripley-pe");
  const coverage = writer.runs.startCoverage(runId, {
    target: { kind: "category", externalId: `${invocationId}-membership` },
    maxRequests: null,
    maxDurationMs: null,
    requestedPages: null,
  });
  return { runId, ...coverage };
}

function finishLinkedCoverage(
  writer: CatalogWriter,
  coverageId: number,
  options: {
    status?: "complete" | "partial";
    authoritative?: boolean;
    productsSeen?: number;
    inactivityMissThreshold?: number;
  } = {},
) {
  const status = options.status ?? "complete";
  const authoritative = status === "complete" && options.authoritative === true;
  return writer.runs.finishCoverage(coverageId, {
    status,
    authoritative,
    stopReason: status === "complete" ? "completed" : "budget_exhausted",
    requestsMade: 1,
    productsSeen: options.productsSeen ?? 0,
    duplicatesSeen: 0,
    productsRejected: 0,
    boundary: status === "complete" ? { complete: true } : null,
    inactivityMissThreshold: authoritative ? (options.inactivityMissThreshold ?? null) : null,
  });
}


function sourceFilesUnder(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) result.push(path);
  }
  return result;
}

describe("P-007 frozen support matrix and one-shot architecture", () => {
  test("freezes all 60 cells truthfully: exactly 12 fixture-backed acquire/repair cells are supported", () => {
    const p007Cells = CAPABILITY_SUPPORT_MATRIX.filter((cell) => cell.capability !== "select");
    const supported = p007Cells
      .filter((cell) => cell.supported)
      .map((cell) => `${cell.site}:${cell.strategy}:${cell.capability}`)
      .sort();
    const expected = SITE_DEFINITIONS.flatMap((site) =>
      (["category", "search"] as const).flatMap((strategy) =>
        (["acquire", "repair"] as const).map((capability) => `${site.site}:${strategy}:${capability}`),
      ),
    ).sort();
    expect(p007Cells).toHaveLength(4 * 5 * 4);
    expect(supported).toEqual(expected);
    expect(Object.isFrozen(CAPABILITY_SUPPORT_MATRIX)).toBe(true);
    for (const cell of p007Cells) {
      if (cell.supported) expect(cell.evidence.length).toBeGreaterThanOrEqual(2);
      else expect(cell.reason.length).toBeGreaterThan(10);
    }
  });

  test("all 48 unsupported cells fail before OMP, HTTP, repair, or catalog side effects", async () => {
    let analysisCalls = 0;
    let ingestCalls = 0;
    let repairCalls = 0;
    const sessionRunner: AgentSessionRunner = {
      async run() {
        analysisCalls += 1;
        throw new Error("must not analyze unsupported cells");
      },
    };
    const ingestExecutor: IngestExecutor = {
      async execute() {
        ingestCalls += 1;
        throw new Error("must not ingest unsupported cells");
      },
    };
    const repairExecutor: RepairInvocationExecutor = {
      async execute() {
        repairCalls += 1;
        throw new Error("must not repair unsupported cells");
      },
    };
    const unsupported = CAPABILITY_SUPPORT_MATRIX.filter((cell) => cell.capability !== "select" && !cell.supported);
    expect(unsupported).toHaveLength(64);
    for (const cell of unsupported) {
      let caught: unknown;
      try {
        await invokeOneShot(manifest(cell.site, cell.strategy, cell.capability), {
          config: CONFIG,
          sessionRunner,
          ingestExecutor,
          repairExecutor,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "UNSUPPORTED_INVOCATION" });
    }
    expect({ analysisCalls, ingestCalls, repairCalls }).toEqual({ analysisCalls: 0, ingestCalls: 0, repairCalls: 0 });
  });

  test("composition contains only base/site/strategy/capability/manifest inputs and hostile loader/scheduler fields fail strict parsing", () => {
    const composition = composeInvocation(manifest("ripley-pe", "category", "acquire"));
    expect(composition.prompt.match(/^# .*$/gm)).toEqual([
      "# Base",
      "# Site",
      "# Strategy",
      "# Capability",
      "# Manifest",
    ]);
    expect(composition.site.repairRoots).toEqual(["apps/ingest/src/scrapers/ripley-pe"]);
    for (const extra of [
      { scraperId: "arbitrary-module" },
      { sourcePath: "/tmp/loader.ts" },
      { dueAt: "2026-07-18T00:00:00.000Z" },
      { retry: { attempts: 3 } },
      { queueState: "queued" },
    ]) {
      expect(InvocationContextSchema.safeParse({ ...manifest("ripley-pe", "category", "acquire"), ...extra }).success).toBe(false);
    }
  });
});
describe("P-007 manifest to fake OMP to fixed runner to catalog", () => {
  test("runs all eight acquire cells concurrently in analysis and serially at the writer with terminal metrics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapito-p007-acquire-"));
    const writer = openCatalogWriter(join(dir, "catalog.sqlite"), { migrate: true });
    const session = new ParallelDeterministicSession(8);
    const executor = new FixtureCatalogExecutor(writer);
    const writeGate = new WriteGate();
    try {
      const invocations = SITE_DEFINITIONS.flatMap((site) => [
        manifest(site.site, "category", "acquire"),
        manifest(site.site, "search", "acquire"),
      ]);
      const executions = await Promise.all(invocations.map((invocation) =>
        invokeOneShot(invocation, {
          config: CONFIG,
          sessionRunner: session,
          ingestExecutor: executor,
          writeGate,
        }),
      ));

      expect(session.calls).toBe(8);
      expect(session.maxObserved).toBeGreaterThan(1);
      expect(executor.calls).toBe(8);
      expect(executor.maxObserved).toBe(1);
      expect(writeGate.maxObserved).toBe(1);
      expect(executions.every(({ result, states }) => result.status === "completed" && states.at(-1) === "terminal")).toBe(true);
      expect(executions.map(({ result }) => result.usage.requests)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      expect(executions.reduce((sum, { result }) => sum + result.usage.productsSaved, 0)).toBe(20);
      expect(executions.every(({ result }) =>
        result.usage.llm?.costUsd === 0.001 && result.usage.imagesDownloaded === 0 && result.error === null,
      )).toBe(true);
      expect(executions.filter(({ result }) => result.strategy === "category").every(({ result }) =>
        result.coverage?.status === "complete" && result.coverage.authoritative === false,
      )).toBe(true);
      expect(executions.filter(({ result }) => result.strategy === "search").every(({ result }) => result.coverage === null)).toBe(true);
      expect([...executor.requestedUrls].sort()).toEqual(invocations.map(expectedFixtureUrl).sort());

      expect(sqliteCount(writer, "scraper_runs")).toBe(8);
      expect(sqliteCount(writer, "target_coverages")).toBe(4);
      expect(sqliteCount(writer, "products")).toBe(10);
      expect(sqliteCount(writer, "price_observations")).toBe(10);
      expect(sqliteCount(writer, "product_sightings")).toBe(10);
    } finally {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("links one terminal Invocation to drop/low, authoritative activity, reactivation, and retention in the same temp catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapito-p007-linked-"));
    const writer = openCatalogWriter(join(dir, "catalog.sqlite"), { migrate: true });
    try {
      const invocation = manifest("ripley-pe", "category", "acquire", "linked-history");
      const execution = await invokeOneShot(invocation, {
        config: CONFIG,
        sessionRunner: new ParallelDeterministicSession(),
        ingestExecutor: new FixtureCatalogExecutor(writer),
        writeGate: new WriteGate(),
      });
      expect(execution.result).toMatchObject({
        invocationId: invocation.invocationId,
        status: "completed",
        capability: "acquire",
        coverage: { status: "complete" },
      });
      expect(execution.states.at(-1)).toBe("terminal");

      const prices: ProductInput["price"][] = [
        { regularCents: 10_000, offerCents: null, cardCents: null, currency: "PEN", inStock: true },
        { regularCents: 12_000, offerCents: null, cardCents: null, currency: "PEN", inStock: true },
        { regularCents: 12_000, offerCents: null, cardCents: null, currency: "PEN", inStock: true },
        { regularCents: null, offerCents: 9_000, cardCents: null, currency: "PEN", inStock: true },
        { regularCents: null, offerCents: 7_000, cardCents: null, currency: "PEN", inStock: false },
        { regularCents: null, offerCents: 6_000, cardCents: null, currency: "PEN", inStock: true },
      ];
      const snapshots = prices.map((price, index) => {
        const coverage = startLinkedCoverage(writer, invocation.invocationId, `price-${index}`);
        const snapshot = writer.catalog.productSnapshot(
          coverage.runId,
          "ripley-pe",
          linkedProduct(invocation.invocationId, price),
          [],
          { coverageId: coverage.coverageId },
        );
        finishLinkedCoverage(writer, coverage.coverageId, { productsSeen: 1 });
        return { ...snapshot, targetId: coverage.targetId };
      });
      const productId = snapshots[0]!.productId;
      expect(snapshots.every((snapshot) => snapshot.sightingInserted)).toBe(true);
      expect(snapshots[2]).toMatchObject({
        priceInserted: false,
        priceObservationId: snapshots[1]!.priceObservationId,
      });

      const queries = new CatalogQueries(writer.db);
      const movements = queries.getPriceMovements(productId);
      expect(movements.map((movement) => movement.effectiveCents)).toEqual([10_000, 12_000, 9_000, 7_000, 6_000]);
      expect(movements[1]).toMatchObject({ isPriceDrop: false, previousEffectiveCents: 10_000 });
      expect(movements[2]).toMatchObject({ isPriceDrop: true, isHistoricalLow: true, priorHistoricalLowCents: 10_000 });
      expect(movements[3]).toMatchObject({ isPriceDrop: false, isHistoricalLow: false, inStock: false });
      expect(movements[4]).toMatchObject({ isPriceDrop: true, isHistoricalLow: true, previousEffectiveCents: 7_000 });

      const partial = startLinkedCoverage(writer, invocation.invocationId, "partial-miss");
      expect(finishLinkedCoverage(writer, partial.coverageId, { status: "partial" })).toEqual({
        membershipsMissed: 0,
        membershipsInactivated: 0,
      });
      const firstMiss = startLinkedCoverage(writer, invocation.invocationId, "authoritative-miss-1");
      expect(finishLinkedCoverage(writer, firstMiss.coverageId, {
        authoritative: true,
        inactivityMissThreshold: 2,
      })).toEqual({ membershipsMissed: 1, membershipsInactivated: 0 });
      const secondMiss = startLinkedCoverage(writer, invocation.invocationId, "authoritative-miss-2");
      expect(finishLinkedCoverage(writer, secondMiss.coverageId, {
        authoritative: true,
        inactivityMissThreshold: 2,
      })).toEqual({ membershipsMissed: 1, membershipsInactivated: 1 });
      expect(queries.listTargetMemberships(snapshots[0]!.targetId)).toEqual([]);

      const reactivation = startLinkedCoverage(writer, invocation.invocationId, "reactivation");
      writer.catalog.productSnapshot(
        reactivation.runId,
        "ripley-pe",
        linkedProduct(invocation.invocationId, prices.at(-1)!),
        [],
        { coverageId: reactivation.coverageId },
      );
      finishLinkedCoverage(writer, reactivation.coverageId, { productsSeen: 1 });
      expect(queries.listTargetMemberships(snapshots[0]!.targetId)[0]).toMatchObject({
        inactiveAt: null,
        consecutiveCompleteMisses: 0,
      });

      const historyBefore = queries.getOfferHistory(productId);
      const movementsBefore = queries.getPriceMovements(productId);
      const dropsBefore = queries.searchCurrentPriceDrops();
      const priceRowsBefore = sqliteCount(writer, "price_observations");
      const lease = writer.writerLease.acquire();
      try {
        const baseRequest = {
          schemaVersion: 1 as const,
          sightingsBefore: new Date(Date.now() + 60_000).toISOString(),
          batchSize: 100,
        };
        const dryRun = writer.retention.run({
          ...baseRequest,
          invocationId: `${invocation.invocationId}-retention-dry`,
          dryRun: true,
        }, lease);
        expect(dryRun.candidates).toBeGreaterThan(0);
        expect(dryRun.sightingsDeleted).toBe(0);
        const compacted = writer.retention.run({
          ...baseRequest,
          invocationId: `${invocation.invocationId}-retention-live`,
          dryRun: false,
        }, lease);
        expect(compacted.sightingsDeleted).toBe(dryRun.candidates);
      } finally {
        writer.writerLease.release();
      }
      expect(queries.getOfferHistory(productId)).toEqual(historyBefore);
      expect(queries.getPriceMovements(productId)).toEqual(movementsBefore);
      expect(queries.searchCurrentPriceDrops()).toEqual(dropsBefore);
      expect(sqliteCount(writer, "price_observations")).toBe(priceRowsBefore);
    } finally {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });


});

describe("P-007 explicit hash-bound repair lifecycle", () => {
  test("all eight supported repair cells terminate awaiting human approval using temp-only static-registry canaries", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scrapito-p007-repair-"));
    const host = new TempRepairHost(tempRoot);
    const repairExecutor = new LifecycleRepairInvocationExecutor(host, repairPlanner, "fake/repair-agent");
    let ingestCalls = 0;
    try {
      const invocations = SITE_DEFINITIONS.flatMap((site) => [
        manifest(site.site, "category", "repair"),
        manifest(site.site, "search", "repair"),
      ]);
      const executions = [];
      for (const invocation of invocations) {
        executions.push(await invokeOneShot(invocation, {
          config: CONFIG,
          sessionRunner: new ParallelDeterministicSession(),
          ingestExecutor: { async execute() { ingestCalls += 1; throw new Error("repair must not ingest"); } },
          repairExecutor,
        }));
      }
      expect(ingestCalls).toBe(0);
      expect(executions.every(({ result, states }) =>
        result.status === "partial" && result.capability === "repair" && states.at(-1) === "awaiting_approval",
      )).toBe(true);
      expect(executions.every(({ result }) =>
        result.artifacts.filter((artifact) => artifact.sha256 !== null).length === 7 && result.error === null,
      )).toBe(true);
      expect(host.workspaceRoots.every((root) => root.startsWith(tempRoot))).toBe(true);
      expect(host.canaryScrapers).toHaveLength(16);
      expect(new Set(host.canaryScrapers)).toEqual(new Set(SITE_DEFINITIONS.map((site) => site.scraperId)));
      for (let index = 0; index < host.canaryHashes.length; index += 2) {
        expect(host.canaryHashes[index]).toBe(host.canaryHashes[index + 1]);
      }
      expect(new Set(host.canaryHashes).size).toBe(4);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects every candidate/approval hash tamper, serializes human promotion, and rolls back exact baseline on canary failure", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scrapito-p007-promotion-"));
    const host = new TempRepairHost(tempRoot);
    try {
      const composition = composeInvocation(manifest("ripley-pe", "category", "repair", "promotion"));
      const candidate = await runRepairLifecycle({ composition, host, planner: repairPlanner });
      expect(candidate.states.at(-1)).toBe("awaiting_approval");
      assertCandidateIntegrity(candidate);
      for (const hashName of Object.keys(candidate.hashes) as Array<keyof RepairCandidate["hashes"]>) {
        const tampered = structuredClone(candidate);
        tampered.hashes[hashName] = hashRepairValue(`tampered-${hashName}`);
        expect(() => assertCandidateIntegrity(tampered)).toThrow(/hash mismatch/);
      }

      const approval = createHumanApproval(candidate, "human.operator@example.test");
      assertApprovalCurrent(candidate, approval);
      const tamperedApproval = structuredClone(approval);
      tamperedApproval.hashes.canarySha256 = hashRepairValue("tampered-approval-canary");
      expect(() => assertApprovalCurrent(candidate, tamperedApproval)).toThrow(/bind/);

      const gate = new WriteGate();
      const site = SITE_DEFINITIONS.find((definition) => definition.site === candidate.site)!;
      const promotionHost = new FailingCanaryPromotionHost(tempRoot, site.repairRoots[0]!);
      const firstPromise = promoteApprovedRepair({ candidate, approval, site, host: promotionHost, writeGate: gate });
      await promotionHost.firstApplyStarted;
      expect(await promotionHost.currentTreeSha256(site.repairRoots[0]!)).toBe(hashRepairValue(REPAIR_CANDIDATE_CONTENT));
      const secondPromise = promoteApprovedRepair({ candidate, approval, site, host: promotionHost, writeGate: gate });
      await drainMicrotasks();
      expect(promotionHost.active).toBe(1);
      expect(promotionHost.maxObserved).toBe(1);
      promotionHost.releaseApply();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      for (const result of [first, second]) {
        expect(result.status).toBe("rolled_back");
        expect(result.states).toEqual(["approved", "promoted", "production_canary", "rolled_back"]);
        expect(result.rollbackSha256).toBe(BASELINE_TREE);
      }
      expect(gate.maxObserved).toBe(1);
      expect(promotionHost.maxObserved).toBe(1);
      expect(promotionHost.rollbackCalls).toBe(2);
      expect(promotionHost.treeSha256).toBe(BASELINE_TREE);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("P-007 architecture negative checks", () => {
  test("final SQLite/runtime has no job owner, dynamic scraper loader, consumer, or policy bypass", () => {
    const writer = openCatalogWriter(":memory:", { migrate: true });
    try {
      const legacyJobTable = writer.db.query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get("scrape_jobs");
      expect(legacyJobTable).toBeNull();
    } finally {
      writer.close();
    }

    const runtimeRoots = [
      join(ROOT, "apps/agent/src"),
      join(ROOT, "packages/catalog/src/read"),
      join(ROOT, "packages/catalog/src/write"),
      join(ROOT, "apps/ingest/src/targets"),
    ];
    const runtimeSource = runtimeRoots
      .flatMap(sourceFilesUnder)
      .map((path) => `// ${relative(ROOT, path)}\n${readFileSync(path, "utf8")}`)
      .join("\n");
    expect(runtimeSource).not.toMatch(/\b(?:JobContext|JobResult|jobRegistry|selectDueTargets|nextRunAt|dueAt|scheduledAt)\b/);
    expect(readdirSync(join(ROOT, ".omp/agents")).sort()).toEqual(["repair-agent.md", "site-agent.md", "verifier.md"]);

    const registrySource = readFileSync(join(ROOT, "apps/ingest/src/scrapers/registry.ts"), "utf8");
    expect(registrySource).not.toContain("import(");
    expect(registrySource.match(/from "\.\/(?:ripley-pe|falabella-pe|promart-pe|oechsle-pe)\/products\.ts"/g)).toHaveLength(4);
    const runnerSource = readFileSync(join(ROOT, "apps/ingest/src/app/scrape-runner.ts"), "utf8");
    expect(runnerSource).not.toMatch(/(?<!\.)\bfetch\(url/);
  });
});
