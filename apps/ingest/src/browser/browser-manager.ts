/**
 * BrowserManager / BrowserSession / BrowserTab — persistent labeled-tab
 * management on top of AgentBrowserDriver.
 *
 * Key invariants:
 *  - The active tab is GLOBAL to an agent-browser session, so every
 *    switch-plus-operation is serialized through a per-session mutex.
 *  - Labels are our own registry mapping to stable agent-browser tabIds (t1..).
 *  - Duplicate live labels are rejected; missing tabs are recreated.
 *  - Snapshot refs are tab-scoped and invalid after switching tabs.
 */
import { ScrapError } from "@scrapito/contracts";
import { KeyedMutex } from "../util/mutex.ts";
import { nullLogger, type Logger } from "../util/logger.ts";
import { extractNextData } from "../util/html-extract.ts";
import { AgentBrowserDriver } from "./agent-browser-driver.ts";
import type { WireTab } from "./wire.ts";
import {
  noopTabStore,
  type AccessibilitySnapshot,
  type GotoOptions,
  type NetworkFilter,
  type NetworkRequest,
  type StartOptions,
  type TabInfo,
  type TabOptions,
  type TabPurpose,
  type TabRegistryStore,
} from "./types.ts";

interface RegistryEntry {
  tabId: string;
  label: string;
  purpose?: TabPurpose;
  createdAt: number;
  lastUsedAt: number;
  ownedByRun: boolean;
}

export interface ManagerOptions {
  bin: string;
  timeoutMs: number;
  logger?: Logger;
  tabStore?: TabRegistryStore;
}

export class BrowserManager {
  private readonly logger: Logger;
  private readonly tabStore: TabRegistryStore;

  constructor(private readonly options: ManagerOptions) {
    this.logger = options.logger ?? nullLogger;
    this.tabStore = options.tabStore ?? noopTabStore;
  }

  async start(options: StartOptions): Promise<BrowserSession> {
    const driver = new AgentBrowserDriver({
      session: options.session,
      bin: this.options.bin,
      timeoutMs: this.options.timeoutMs,
      restoreKey: options.restoreKey,
      headless: options.headless,
      userAgent: options.userAgent,
      browserArgs: options.browserArgs,
    });
    return new BrowserSession(
      driver,
      new KeyedMutex(),
      this.tabStore,
      this.logger.child({ session: options.session }),
    );
  }
}

export class BrowserSession {
  private readonly registry = new Map<string, RegistryEntry>();
  private activeTabId: string | undefined;

  constructor(
    private readonly driver: AgentBrowserDriver,
    private readonly mutex: KeyedMutex,
    private readonly tabStore: TabRegistryStore,
    private readonly logger: Logger,
  ) {}

  get name(): string {
    return this.driver.sessionName;
  }

  /** Run `fn` while holding the session lock. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(this.driver.sessionName, fn);
  }

  private async refreshRegistry(): Promise<WireTab[]> {
    const tabs = await this.driver.listTabs();
    const live = new Set(tabs.map((t) => t.tabId));
    for (const [label, entry] of this.registry) {
      if (!live.has(entry.tabId)) this.registry.delete(label);
    }
    const active = tabs.find((t) => t.active);
    this.activeTabId = active?.tabId;
    return tabs;
  }

  async tabs(): Promise<ReadonlyArray<TabInfo>> {
    return this.runExclusive(async () => {
      const tabs = await this.refreshRegistry();
      const labelByTabId = new Map<string, string>();
      for (const entry of this.registry.values()) labelByTabId.set(entry.tabId, entry.label);
      return tabs.map((t) => ({
        id: t.tabId,
        label: labelByTabId.get(t.tabId),
        url: t.url,
        active: t.active,
      }));
    });
  }

  /**
   * Get (or create) a labeled tab. `reuse` defaults to true: an existing live
   * tab with this label is returned; otherwise a new tab is created and
   * registered. A duplicate live label with reuse=false is rejected.
   */
  async tab(label: string, options: TabOptions = {}): Promise<BrowserTab> {
    const reuse = options.reuse ?? true;
    return this.runExclusive(async () => {
      await this.refreshRegistry();
      const existing = this.registry.get(label);
      if (existing) {
        if (!reuse) {
          throw new ScrapError(
            "DUPLICATE_TAB_LABEL",
            `tab label "${label}" already exists in session ${this.name}`,
          );
        }
        existing.lastUsedAt = Date.now();
        if (options.url) {
          await this.ensureActive(existing.tabId);
          await this.driver.open(options.url);
        }
        return new BrowserTab(this, this.driver, existing.tabId, label);
      }

      const tabId = await this.driver.newTab(options.url);
      const entry: RegistryEntry = {
        tabId,
        label,
        purpose: options.purpose,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        ownedByRun: options.purpose === "discovery",
      };
      this.registry.set(label, entry);
      this.activeTabId = tabId;
      this.tabStore.upsert(this.name, {
        tabId,
        label,
        url: options.url ?? "about:blank",
        purpose: options.purpose,
      });
      return new BrowserTab(this, this.driver, tabId, label);
    });
  }

  /** Ensure `tabId` is the active tab, switching (and recreating) if needed.
   * MUST be called while holding the session lock. */
  async ensureActive(tabId: string): Promise<void> {
    if (this.activeTabId === tabId) return;
    const tabs = await this.driver.listTabs();
    if (!tabs.some((t) => t.tabId === tabId)) {
      throw new ScrapError("TAB_DISAPPEARED", `tab ${tabId} no longer exists`);
    }
    await this.driver.switchTab(tabId);
    this.activeTabId = tabId;
  }

  async closeTab(labelOrId: string): Promise<void> {
    await this.runExclusive(async () => {
      const entry =
        this.registry.get(labelOrId) ??
        [...this.registry.values()].find((e) => e.tabId === labelOrId);
      const tabId = entry?.tabId ?? labelOrId;
      await this.driver.closeTab(tabId).catch(() => {});
      if (entry) this.registry.delete(entry.label);
      if (this.activeTabId === tabId) this.activeTabId = undefined;
      this.tabStore.remove(this.name, tabId);
    });
  }

  /** Close tabs idle for longer than `maxAgeMs`. Returns count closed. */
  async closeIdle(maxAgeMs: number): Promise<number> {
    return this.runExclusive(async () => {
      const now = Date.now();
      let closed = 0;
      for (const entry of [...this.registry.values()]) {
        if (now - entry.lastUsedAt > maxAgeMs) {
          await this.driver.closeTab(entry.tabId).catch(() => {});
          this.registry.delete(entry.label);
          this.tabStore.remove(this.name, entry.tabId);
          closed++;
        }
      }
      return closed;
    });
  }

  async close(): Promise<void> {
    await this.runExclusive(async () => {
      await this.driver.close().catch(() => {});
      this.registry.clear();
      this.activeTabId = undefined;
      this.tabStore.clearSession(this.name);
    });
  }

  touch(label: string): void {
    const entry = this.registry.get(label);
    if (entry) entry.lastUsedAt = Date.now();
  }
}

export class BrowserTab {
  constructor(
    private readonly session: BrowserSession,
    private readonly driver: AgentBrowserDriver,
    readonly id: string,
    readonly label: string,
  ) {}

  /** Run an operation with the active tab guaranteed to be this tab. */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    return this.session.runExclusive(async () => {
      await this.session.ensureActive(this.id);
      this.session.touch(this.label);
      return fn();
    });
  }

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    await this.op(async () => {
      await this.driver.open(url);
      if (options.waitUntil === "networkidle") {
        await this.driver.runJson(["wait", "networkidle"]).catch(() => {});
      }
    });
  }

  /** Discovery-only: evaluate arbitrary JS. */
  evaluate<T = unknown>(expression: string): Promise<T> {
    return this.op(() => this.driver.evaluate<T>(expression));
  }

  /** Discovery-only: accessibility snapshot (refs are tab-scoped). */
  snapshot(): Promise<AccessibilitySnapshot> {
    return this.op(async () => {
      const tree = await this.driver.runJson(["snapshot"]);
      return { tree };
    });
  }

  /** Discovery-only: captured network requests. */
  requests(filter?: NetworkFilter): Promise<NetworkRequest[]> {
    return this.op(async () => {
      const cmd = ["network", "requests"];
      if (filter?.urlPattern) cmd.push("--filter", filter.urlPattern);
      const data = await this.driver.runJson<{ requests?: NetworkRequest[] } | NetworkRequest[]>(cmd);
      return Array.isArray(data) ? data : (data.requests ?? []);
    });
  }

  startHar(path: string): Promise<void> {
    return this.op(async () => {
      await this.driver.runJson(["network", "har", "start", path]);
    });
  }

  stopHar(): Promise<string> {
    return this.op(async () => {
      const data = await this.driver.runJson<{ path?: string } | string>([
        "network",
        "har",
        "stop",
      ]);
      return typeof data === "string" ? data : (data.path ?? "");
    });
  }

  /** Runtime-safe: rendered HTML. */
  html(): Promise<string> {
    return this.op(() => this.driver.getHtml());
  }

  /** Runtime-safe: parse the SSR __NEXT_DATA__ payload from HTML (no eval). */
  async nextData<T = unknown>(): Promise<T> {
    const html = await this.html();
    const parsed = extractNextData<T>(html);
    if (parsed === undefined) {
      throw new ScrapError("NO_NEXT_DATA", "no __NEXT_DATA__ script found in page");
    }
    return parsed;
  }
}

export { extractNextData } from "../util/html-extract.ts";
