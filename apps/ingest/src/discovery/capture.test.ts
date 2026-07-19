import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScrapError } from "@scrapito/contracts";
import type { BrowserSession, BrowserTab } from "../browser/browser-manager.ts";
import type { NetworkRequest } from "../browser/types.ts";
import type { CrawlPolicy } from "../policy/crawl-policy.ts";
import { nullLogger } from "../util/logger.ts";
import { FsDiscoveryArtifacts, sha256Hex } from "./artifacts.ts";
import { runDiscoveryCapture, type DiscoveryScenario } from "./capture.ts";
import type { DiscoveryContext } from "./define-discovery.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Fake browser tab: serves canned HTML/requests and emulates HAR capture by
 * writing a real file on stopHar so the capture flow's existsSync check sees
 * exactly what a real browser would produce. */
class FakeTab {
  startHarCalls: string[] = [];
  stopHarCalls = 0;
  failStartHar = false;
  writeHarOnStop = true;
  nextDataPayload: unknown = null;
  failNextData = false;
  requestsByUrl: NetworkRequest[] = [];

  goto(_url: string, _options?: unknown): Promise<void> {
    return Promise.resolve();
  }
  html(): Promise<string> {
    return Promise.resolve("<html><body>catalog</body></html>");
  }
  nextData(): Promise<unknown> {
    if (this.failNextData) return Promise.reject(new ScrapError("NO_NEXT_DATA", "none"));
    return Promise.resolve(this.nextDataPayload);
  }
  requests(): Promise<NetworkRequest[]> {
    return Promise.resolve(this.requestsByUrl);
  }
  startHar(path: string): Promise<void> {
    if (this.failStartHar) return Promise.reject(new Error("har unsupported"));
    this.startHarCalls.push(path);
    return Promise.resolve();
  }
  stopHar(): Promise<string> {
    this.stopHarCalls++;
    const path = this.startHarCalls[0]!;
    if (this.writeHarOnStop) {
      writeFileSync(path, JSON.stringify({ log: { version: "1.2", entries: [] } }));
    }
    return Promise.resolve(path);
  }
}

interface Harness {
  ctx: DiscoveryContext;
  tab: FakeTab;
  closedLabels: string[];
  artifacts: FsDiscoveryArtifacts;
}

function makeCtx(tabOverrides?: (tab: FakeTab) => void): Harness {
  const base = mkdtempSync(join(tmpdir(), "discovery-capture-"));
  tmpDirs.push(base);
  const tab = new FakeTab();
  tabOverrides?.(tab);
  const closedLabels: string[] = [];
  const artifacts = new FsDiscoveryArtifacts(base, "run-1");
  const browser = {
    tab: () => Promise.resolve(tab as unknown as BrowserTab),
    closeTab: (label: string) => {
      closedLabels.push(label);
      return Promise.resolve();
    },
  } as unknown as BrowserSession;
  const policy = {
    userAgent: "scrapito-test (+https://example.com/bot)",
    assertNavigable: (url: string) => new URL(url),
  } as unknown as CrawlPolicy;
  return { ctx: { browser, policy, artifacts, logger: nullLogger }, tab, closedLabels, artifacts };
}

const SCENARIOS: readonly DiscoveryScenario[] = [
  { name: "home", url: "https://www.promart.pe/" },
  { name: "catalog-tv", url: "https://www.promart.pe/tv" },
];

async function expectScrapError(fn: () => Promise<unknown>, code: string): Promise<ScrapError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ScrapError);
    expect((err as ScrapError).code).toBe(code);
    return err as ScrapError;
  }
  throw new Error(`expected ScrapError ${code}, but nothing was thrown`);
}

describe("runDiscoveryCapture", () => {
  test("happy path: HAR registered in manifest, per-scenario artifacts saved", async () => {
    const { ctx, tab, artifacts } = makeCtx((t) => {
      t.nextDataPayload = { props: { pageProps: {} } };
      t.requestsByUrl = [{ url: "https://www.promart.pe/api/x", method: "GET", status: 200 }];
    });

    const result = await runDiscoveryCapture(ctx, {
      scraperId: "promart-pe",
      store: "promart-pe",
      scenarios: SCENARIOS,
    });

    expect(result.harAvailable).toBe(true);
    expect(result.scenarios).toEqual(["home", "catalog-tv"]);
    expect(result.requestsCaptured).toBe(2); // one canned request per scenario

    const manifest = JSON.parse(readFileSync(join(artifacts.dir, "manifest.json"), "utf8"));
    expect(manifest.harAvailable).toBe(true);
    expect(manifest.scenarios).toEqual(["home", "catalog-tv"]);
    expect(manifest.schemaVersion).toBe(1);

    // The HAR on disk must be the hashed artifact the manifest points at.
    const harEntry = manifest.artifacts.find((a: { name: string }) => a.name === "network.har");
    expect(harEntry).toBeDefined();
    expect(harEntry.sha256).toBe(
      sha256Hex(new Uint8Array(readFileSync(join(artifacts.dir, "network.har")))),
    );

    // Per-scenario evidence exists for both scenarios.
    for (const name of ["home", "catalog-tv"]) {
      expect(existsSync(join(artifacts.dir, `${name}.html`))).toBe(true);
      expect(existsSync(join(artifacts.dir, `${name}.next-data.json`))).toBe(true);
      const requests = JSON.parse(readFileSync(join(artifacts.dir, `${name}.requests.json`), "utf8"));
      expect(requests).toHaveLength(1);
    }
  });

  test("startHar failure degrades to request snapshots: run succeeds, harAvailable=false", async () => {
    const { ctx, artifacts } = makeCtx((t) => {
      t.failStartHar = true;
      t.requestsByUrl = [{ url: "https://www.promart.pe/api/x", method: "GET" }];
    });

    const result = await runDiscoveryCapture(ctx, {
      scraperId: "promart-pe",
      store: "promart-pe",
      scenarios: SCENARIOS.slice(0, 1),
    });

    expect(result.harAvailable).toBe(false);
    expect(result.requestsCaptured).toBe(1);
    expect(existsSync(join(artifacts.dir, "network.har"))).toBe(false);
    expect(existsSync(join(artifacts.dir, "home.requests.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(artifacts.dir, "manifest.json"), "utf8"));
    expect(manifest.harAvailable).toBe(false);
  });

  test("stopHar succeeds but writes no file → harAvailable=false, snapshots remain evidence", async () => {
    const { ctx, artifacts } = makeCtx((t) => {
      t.writeHarOnStop = false;
      t.requestsByUrl = [{ url: "https://www.promart.pe/api/x", method: "GET" }];
    });

    const result = await runDiscoveryCapture(ctx, {
      scraperId: "promart-pe",
      store: "promart-pe",
      scenarios: SCENARIOS.slice(0, 1),
    });

    expect(result.harAvailable).toBe(false);
    expect(result.requestsCaptured).toBe(1);
    const manifest = JSON.parse(readFileSync(join(artifacts.dir, "manifest.json"), "utf8"));
    expect(manifest.harAvailable).toBe(false);
    expect(manifest.artifacts.some((a: { name: string }) => a.name === "network.har")).toBe(false);
  });

  test("no HAR and zero captured requests → DISCOVERY_NO_EVIDENCE and no success manifest", async () => {
    const { ctx, artifacts } = makeCtx((t) => {
      t.failStartHar = true;
      t.requestsByUrl = [];
    });

    await expectScrapError(
      () =>
        runDiscoveryCapture(ctx, {
          scraperId: "promart-pe",
          store: "promart-pe",
          scenarios: SCENARIOS.slice(0, 1),
        }),
      "DISCOVERY_NO_EVIDENCE",
    );
    // Fail-closed: a run without evidence must not freeze a success manifest.
    expect(existsSync(join(artifacts.dir, "manifest.json"))).toBe(false);
  });

  test("non kebab-case scenario name → INVALID_SCENARIO, and HAR is still stopped", async () => {
    const { ctx, tab, closedLabels } = makeCtx();

    await expectScrapError(
      () =>
        runDiscoveryCapture(ctx, {
          scraperId: "promart-pe",
          store: "promart-pe",
          scenarios: [{ name: "Not Kebab!", url: "https://www.promart.pe/" }],
        }),
      "INVALID_SCENARIO",
    );
    // Cleanup contract: the failure must not leak a live HAR or tab.
    expect(tab.stopHarCalls).toBe(1);
    expect(closedLabels).toEqual(["promart-pe-discovery"]);
  });

  test("empty scenarios array → INVALID_SCENARIO before touching the browser", async () => {
    const { ctx, tab } = makeCtx();

    await expectScrapError(
      () =>
        runDiscoveryCapture(ctx, {
          scraperId: "promart-pe",
          store: "promart-pe",
          scenarios: [],
        }),
      "INVALID_SCENARIO",
    );
    expect(tab.startHarCalls).toHaveLength(0);
  });

  test("missing __NEXT_DATA__ is tolerated: scenario still captured without that artifact", async () => {
    const { ctx, artifacts } = makeCtx((t) => {
      t.failNextData = true;
      t.requestsByUrl = [{ url: "https://www.promart.pe/api/x", method: "GET" }];
    });

    const result = await runDiscoveryCapture(ctx, {
      scraperId: "promart-pe",
      store: "promart-pe",
      scenarios: SCENARIOS.slice(0, 1),
    });

    expect(result.harAvailable).toBe(true);
    expect(existsSync(join(artifacts.dir, "home.html"))).toBe(true);
    expect(existsSync(join(artifacts.dir, "home.next-data.json"))).toBe(false);
  });
});
