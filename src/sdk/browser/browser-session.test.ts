import { describe, expect, test } from "bun:test";
import { ScrapError } from "../../domain/errors.ts";
import { nullLogger } from "../../util/logger.ts";
import { KeyedMutex } from "../../util/mutex.ts";
import { AgentBrowserDriver } from "./agent-browser-driver.ts";
import { BrowserSession } from "./browser-manager.ts";
import { noopTabStore } from "./types.ts";
import type { TabRegistryStore } from "./types.ts";
import type { CommandExecutor, ExecResult, WireTab } from "./wire.ts";

/**
 * In-memory stand-in for the real agent-browser tab table: `tab new`
 * appends a live tab, `tab close`/external removal drop it, `tab <id>`
 * switches the active flag. `tab list` always reflects current state, so
 * BrowserSession's reuse/recreate logic runs against realistic data.
 */
class FakeAgentBrowserBackend {
  private readonly liveTabs: WireTab[] = [];
  private counter = 0;

  list(): WireTab[] {
    return this.liveTabs.map((tab) => ({ ...tab }));
  }

  newTab(url?: string): string {
    this.counter += 1;
    const tabId = `t${this.counter}`;
    for (const tab of this.liveTabs) tab.active = false;
    this.liveTabs.push({ tabId, label: null, url: url ?? "about:blank", active: true });
    return tabId;
  }

  closeTab(tabId: string): void {
    const index = this.liveTabs.findIndex((tab) => tab.tabId === tabId);
    if (index !== -1) this.liveTabs.splice(index, 1);
  }

  switchTab(tabId: string): boolean {
    const exists = this.liveTabs.some((tab) => tab.tabId === tabId);
    if (exists) for (const tab of this.liveTabs) tab.active = tab.tabId === tabId;
    return exists;
  }

  /** Simulate a tab closing out-of-band (operator, crash, idle daemon timeout). */
  removeExternally(tabId: string): void {
    this.closeTab(tabId);
  }
}

function commandTail(args: string[]): string[] {
  const index = args.indexOf("--json");
  return index === -1 ? args : args.slice(index + 1);
}

function successResult(data: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify({ success: true, data, error: null }), stderr: "" };
}

function failureResult(error: string): ExecResult {
  return { code: 1, stdout: JSON.stringify({ success: false, data: null, error }), stderr: "" };
}

function respondTo(backend: FakeAgentBrowserBackend, tail: string[]): ExecResult {
  const [command, ...rest] = tail;
  if (command === "tab") {
    const [sub, ...subRest] = rest;
    if (sub === "list") return successResult({ tabs: backend.list() });
    if (sub === "new") return successResult({ tabId: backend.newTab(subRest[0]) });
    if (sub === "close") {
      backend.closeTab(subRest[0] ?? "");
      return successResult({});
    }
    return backend.switchTab(sub ?? "") ? successResult({}) : failureResult(`tab ${sub} not found`);
  }
  if (command === "open") return successResult({});
  if (command === "close") return successResult({});
  if (command === "network" && rest[0] === "har" && rest[1] === "start") return successResult({});
  if (command === "network" && rest[0] === "har" && rest[1] === "stop") {
    return successResult({ path: "/tmp/session.har" });
  }
  return failureResult(`unhandled fake command: ${tail.join(" ")}`);
}

/** A hold lets a test pause exactly one matching call until it explicitly releases it,
 * and await `started` to know the call has actually been reached — no wall-clock guessing. */
interface Hold {
  readonly started: Promise<void>;
  release(): void;
}

class FakeCommandExecutor implements CommandExecutor {
  readonly calls: string[][] = [];
  private readonly holds: Array<{
    match: (tail: string[]) => boolean;
    notifyStarted: () => void;
    gate: Promise<void>;
  }> = [];

  constructor(private readonly backend: FakeAgentBrowserBackend) {}

  holdNext(match: (tail: string[]) => boolean): Hold {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    this.holds.push({ match, notifyStarted: started.resolve, gate: gate.promise });
    return { started: started.promise, release: gate.resolve };
  }

  async exec(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    const tail = commandTail(args);
    const hold = this.holds.find((entry) => entry.match(tail));
    if (hold) {
      this.holds.splice(this.holds.indexOf(hold), 1);
      hold.notifyStarted();
      await hold.gate;
    }
    return respondTo(this.backend, tail);
  }
}

class RecordingTabStore implements TabRegistryStore {
  readonly upserts: Array<{ session: string; tabId: string }> = [];
  readonly removes: Array<{ session: string; tabId: string }> = [];
  readonly cleared: string[] = [];

  upsert(session: string, tab: { tabId: string }): void {
    this.upserts.push({ session, tabId: tab.tabId });
  }

  remove(session: string, tabId: string): void {
    this.removes.push({ session, tabId });
  }

  clearSession(session: string): void {
    this.cleared.push(session);
  }
}

function buildSession(
  sessionName: string,
  tabStore: TabRegistryStore = noopTabStore,
): { session: BrowserSession; executor: FakeCommandExecutor; backend: FakeAgentBrowserBackend } {
  const backend = new FakeAgentBrowserBackend();
  const executor = new FakeCommandExecutor(backend);
  const driver = new AgentBrowserDriver({
    session: sessionName,
    bin: "agent-browser",
    timeoutMs: 1000,
    executor,
  });
  const session = new BrowserSession(driver, new KeyedMutex(), tabStore, nullLogger);
  return { session, executor, backend };
}

describe("BrowserSession.tab", () => {
  test("reuses the same tabId across two calls with the same label", async () => {
    const { session, executor } = buildSession("s1");

    const first = await session.tab("plp");
    const second = await session.tab("plp");

    expect(second.id).toBe(first.id);
    const newTabCalls = executor.calls.filter((args) => commandTail(args).join(" ") === "tab new");
    expect(newTabCalls).toHaveLength(1);
  });

  test("recreates the tab after it disappears externally", async () => {
    const { session, executor, backend } = buildSession("s1");

    const first = await session.tab("plp");
    backend.removeExternally(first.id);
    const second = await session.tab("plp");

    expect(second.id).not.toBe(first.id);
    const newTabCalls = executor.calls.filter((args) => commandTail(args).join(" ") === "tab new");
    expect(newTabCalls).toHaveLength(2);
  });

  test("rejects a duplicate live label when reuse is disabled", async () => {
    const { session } = buildSession("s1");
    await session.tab("plp");

    let caught: unknown;
    try {
      await session.tab("plp", { reuse: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ScrapError);
    expect((caught as ScrapError).code).toBe("DUPLICATE_TAB_LABEL");
  });

  test("two concurrent tab() calls on the same session run serially, never interleaved", async () => {
    const { session, executor } = buildSession("s1");
    const hold = executor.holdNext((tail) => tail.join(" ") === "tab new");

    const pendingA = session.tab("a");
    await hold.started; // 'a' has reached (and is blocked on) its `tab new` call
    const callsWhileHeld = executor.calls.length;

    const pendingB = session.tab("b");
    // 'b' is queued behind the session mutex: its body cannot run — and thus
    // cannot issue any exec() calls — until 'a' finishes, so nothing changed yet.
    expect(executor.calls.length).toBe(callsWhileHeld);

    hold.release();
    const [tabA, tabB] = await Promise.all([pendingA, pendingB]);

    expect(tabA.id).toBe("t1");
    expect(tabB.id).toBe("t2");
    expect(executor.calls.length).toBe(callsWhileHeld + 2);
  });
});

describe("BrowserSession tab cleanup", () => {
  test("closeTab(label) closes the underlying tab and drops it from the registry and tab store", async () => {
    const store = new RecordingTabStore();
    const { session, executor } = buildSession("s1", store);
    const tab = await session.tab("plp");

    await session.closeTab("plp");

    expect(executor.calls.some((args) => commandTail(args).join(" ") === `tab close ${tab.id}`)).toBe(
      true,
    );
    expect(store.removes).toContainEqual({ session: "s1", tabId: tab.id });
    // The label is gone from the registry, so a subsequent tab() call must recreate it.
    const recreated = await session.tab("plp");
    expect(recreated.id).not.toBe(tab.id);
  });

  test("closeIdle(maxAgeMs) closes only tabs whose idle time exceeds the threshold", async () => {
    const { session, executor } = buildSession("s1");
    await session.tab("plp");

    const closedNone = await session.closeIdle(Number.POSITIVE_INFINITY);
    expect(closedNone).toBe(0);

    const closedAll = await session.closeIdle(-1);
    expect(closedAll).toBe(1);
    expect(executor.calls.some((args) => commandTail(args)[0] === "tab" && commandTail(args)[1] === "close")).toBe(
      true,
    );
  });

  test("close() clears only its own session's tab registry entries", async () => {
    const store = new RecordingTabStore();
    const sessionA = buildSession("session-a", store);
    const sessionB = buildSession("session-b", store);
    await sessionA.session.tab("plp");
    await sessionB.session.tab("plp");

    await sessionA.session.close();

    expect(store.cleared).toEqual(["session-a"]);
    expect(sessionA.executor.calls.some((args) => commandTail(args).join(" ") === "close")).toBe(true);
    expect(sessionB.executor.calls.some((args) => commandTail(args).join(" ") === "close")).toBe(false);
  });
});

describe("BrowserTab HAR capture", () => {
  test("startHar/stopHar issue the expected network har commands", async () => {
    const { session, executor } = buildSession("s1");
    const tab = await session.tab("discovery", { purpose: "discovery" });

    await tab.startHar("/tmp/run.har");
    const path = await tab.stopHar();

    expect(path).toBe("/tmp/session.har");
    const tails = executor.calls.map((args) => commandTail(args).join(" "));
    expect(tails).toContain("network har start /tmp/run.har");
    expect(tails).toContain("network har stop");
  });
});
