/**
 * Shared discovery capture flow: one browser HAR spanning every scenario plus
 * a per-scenario `network requests` snapshot as redundancy. HAR capture is
 * fail-closed: if the browser cannot start/stop the HAR or the file never
 * materializes, the run is marked `harAvailable: false` in the manifest and
 * the request snapshots become the primary evidence. A run with neither HAR
 * nor any captured request throws instead of reporting false success.
 */
import { existsSync, readFileSync } from "node:fs";
import { ScrapError, type StoreId } from "@scrapito/contracts";
import type { BrowserTab } from "../browser/browser-manager.ts";
import type { DiscoveryContext } from "./define-discovery.ts";

export interface DiscoveryScenario {
  /** kebab-case; used in artifact filenames. */
  readonly name: string;
  readonly url: string;
}

export interface DiscoveryCaptureResult {
  readonly harAvailable: boolean;
  readonly scenarios: readonly string[];
  readonly requestsCaptured: number;
}

const SCENARIO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Capture one scenario's HTML, __NEXT_DATA__ (when present) and network
 * request summary. All artifacts land under `<scenario>.<kind>`. */
async function captureScenario(
  ctx: DiscoveryContext,
  tab: BrowserTab,
  scenario: DiscoveryScenario,
): Promise<number> {
  if (!SCENARIO_NAME.test(scenario.name)) {
    throw new ScrapError("INVALID_SCENARIO", `scenario name must be kebab-case: ${scenario.name}`);
  }
  ctx.policy.assertNavigable(scenario.url);
  await tab.goto(scenario.url, { waitUntil: "networkidle" });
  ctx.artifacts.save(`${scenario.name}.html`, await tab.html());
  const nextData = await tab.nextData().catch(() => null);
  if (nextData !== null) ctx.artifacts.saveJson(`${scenario.name}.next-data.json`, nextData);
  const requests = await tab.requests().catch(() => []);
  ctx.artifacts.saveJson(`${scenario.name}.requests.json`, requests);
  ctx.logger.info("discovery scenario captured", { scenario: scenario.name, requests: requests.length });
  return requests.length;
}

export interface DiscoveryCaptureOptions {
  readonly scraperId: string;
  readonly store: StoreId;
  readonly scenarios: readonly DiscoveryScenario[];
}

/** Run the full capture: HAR around every scenario, per-scenario snapshots,
 * then freeze the manifest. Returns evidence metadata for the CLI to echo. */
export async function runDiscoveryCapture(
  ctx: DiscoveryContext,
  options: DiscoveryCaptureOptions,
): Promise<DiscoveryCaptureResult> {
  const { scenarios } = options;
  if (scenarios.length === 0) {
    throw new ScrapError("INVALID_SCENARIO", "discovery needs at least one scenario");
  }
  const startedAt = new Date().toISOString();
  const tabLabel = `${options.scraperId}-discovery`;
  const tab = await ctx.browser.tab(tabLabel, { purpose: "discovery" });
  const harPath = `${ctx.artifacts.dir}/network.har`;

  let harActive = false;
  try {
    await tab.startHar(harPath);
    harActive = true;
  } catch (err) {
    ctx.logger.warn("HAR capture unavailable; falling back to request snapshots", {
      error: String(err),
    });
  }

  let requestsCaptured = 0;
  try {
    for (const scenario of scenarios) {
      requestsCaptured += await captureScenario(ctx, tab, scenario);
    }
  } finally {
    if (harActive) {
      await tab.stopHar().catch((err) => {
        harActive = false;
        ctx.logger.warn("HAR stop failed; HAR discarded", { error: String(err) });
      });
    }
    await ctx.browser.closeTab(tabLabel).catch(() => {});
  }

  // Register the HAR in the manifest only if the browser actually wrote it.
  let harAvailable = false;
  if (harActive && existsSync(harPath)) {
    const bytes = new Uint8Array(readFileSync(harPath));
    if (bytes.byteLength > 0) {
      ctx.artifacts.save("network.har", bytes);
      harAvailable = true;
    }
  }
  if (!harAvailable) {
    ctx.logger.warn("no HAR evidence; manifest will mark harAvailable=false");
  }
  if (!harAvailable && requestsCaptured === 0) {
    throw new ScrapError(
      "DISCOVERY_NO_EVIDENCE",
      "discovery produced neither a HAR nor any captured requests",
    );
  }

  ctx.artifacts.writeManifest({
    scraperId: options.scraperId,
    store: options.store,
    startedAt,
    userAgent: ctx.policy.userAgent,
    scenarios: scenarios.map((s) => s.name),
    harAvailable,
  });
  return { harAvailable, scenarios: scenarios.map((s) => s.name), requestsCaptured };
}
