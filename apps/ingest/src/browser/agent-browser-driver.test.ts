import { describe, expect, test } from "bun:test";
import {
  AgentBrowserCommandError,
  AgentBrowserProcessError,
} from "@scrapito/contracts";
import { AgentBrowserDriver } from "./agent-browser-driver.ts";
import type { CommandExecutor, ExecOptions, ExecResult } from "./wire.ts";
import contract from "./__fixtures__/agent-browser-contract.json";

/**
 * Fake CommandExecutor: replays one recorded ExecResult per call (FIFO) and
 * records every invocation so tests can assert on the exact argv sent to
 * the pinned agent-browser binary. No real subprocess is ever spawned.
 */
class FakeCommandExecutor implements CommandExecutor {
  readonly calls: Array<{ args: string[]; options: ExecOptions }> = [];
  private readonly queue: ExecResult[] = [];

  enqueue(result: ExecResult): this {
    this.queue.push(result);
    return this;
  }

  async exec(args: string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push({ args, options });
    const next = this.queue.shift();
    if (!next) throw new Error(`FakeCommandExecutor: no result queued for ${args.join(" ")}`);
    return next;
  }
}

function ok(code: number, stdout: string): ExecResult {
  return { code, stdout, stderr: "" };
}

describe("AgentBrowserDriver.runJson", () => {
  test("returns `data` from a valid success envelope", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.single.success)),
    );
    const driver = new AgentBrowserDriver({
      session: "contract-probe",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    const data = await driver.runJson(["get", "title"]);

    expect(data).toEqual(contract.single.success.data);
  });

  test("sends the pinned CLI's global flags plus the given command as argv", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.single.success)),
    );
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 5000,
      executor,
    });

    await driver.runJson(["get", "title"]);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.args).toEqual(["--session", "s1", "--json", "get", "title"]);
    expect(executor.calls[0]?.options.timeoutMs).toBe(5000);
  });

  test("throws AgentBrowserCommandError on a valid failure envelope even with a non-zero exit code", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(1, JSON.stringify(contract.single.failure)),
    );
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    let caught: unknown;
    try {
      await driver.runJson(["click", "@missing"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentBrowserCommandError);
    expect((caught as AgentBrowserCommandError).message).toBe(contract.single.failure.error);
    expect((caught as AgentBrowserCommandError).code).toBe("AGENT_BROWSER_COMMAND");
  });

  test("throws AgentBrowserProcessError on malformed (non-JSON) stdout", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, "not json output {{{"),
    );
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    let caught: unknown;
    try {
      await driver.runJson(["get", "title"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentBrowserProcessError);
    expect((caught as AgentBrowserProcessError).code).toBe("AGENT_BROWSER_PROCESS");
    expect((caught as AgentBrowserProcessError).message).toContain("malformed");
  });

  test("throws AgentBrowserProcessError when the executor reports a spawn failure", async () => {
    const executor = new FakeCommandExecutor().enqueue({
      code: -1,
      stdout: "",
      stderr: "",
      spawnError: new Error("ENOENT: agent-browser not found"),
    });
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    let caught: unknown;
    try {
      await driver.runJson(["get", "title"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentBrowserProcessError);
    expect((caught as AgentBrowserProcessError).message).toContain("failed to spawn");
    expect((caught as AgentBrowserProcessError).message).toContain("ENOENT");
  });

  test("throws AgentBrowserProcessError when the process times out with no JSON on stdout", async () => {
    const executor = new FakeCommandExecutor().enqueue({
      code: -1,
      stdout: "",
      stderr: "still loading",
      timedOut: true,
    });
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 250,
      executor,
    });

    let caught: unknown;
    try {
      await driver.runJson(["wait", "networkidle"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentBrowserProcessError);
    expect((caught as AgentBrowserProcessError).message).toContain("timed out");
    expect((caught as AgentBrowserProcessError).message).toContain("250ms");
  });
});

describe("AgentBrowserDriver.runBatch", () => {
  test("parses each batch entry's `result` field, not `data`", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.batch)),
    );
    const driver = new AgentBrowserDriver({
      session: "contract-probe",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    const entries = await driver.runBatch(["get title", "get url"]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.result).toEqual(contract.batch[0]?.result);
    expect(entries[1]?.result).toEqual(contract.batch[1]?.result);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("data");
    }
  });

  test("defaults to --bail and appends every command line", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.batch)),
    );
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    await driver.runBatch(["get title", "get url"]);

    expect(executor.calls[0]?.args).toEqual([
      "--session",
      "s1",
      "--json",
      "batch",
      "--bail",
      "get title",
      "get url",
    ]);
  });

  test("omits --bail when { bail: false } is passed", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.batch)),
    );
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    await driver.runBatch(["get title"], { bail: false });

    expect(executor.calls[0]?.args).toEqual(["--session", "s1", "--json", "batch", "get title"]);
  });

  test("throws AgentBrowserProcessError when stdout does not parse to an array", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.single.success)),
    );
    const driver = new AgentBrowserDriver({
      session: "s1",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    await expect(driver.runBatch(["get title"])).rejects.toBeInstanceOf(AgentBrowserProcessError);
  });
});

describe("AgentBrowserDriver tab helpers", () => {
  test("listTabs() maps `tab list` data.tabs using the captured contract shape", async () => {
    const executor = new FakeCommandExecutor().enqueue(
      ok(0, JSON.stringify(contract.tabList)),
    );
    const driver = new AgentBrowserDriver({
      session: "contract-probe",
      bin: "agent-browser",
      timeoutMs: 1000,
      executor,
    });

    const tabs = await driver.listTabs();

    expect(tabs).toEqual(contract.tabList.data.tabs);
    expect(executor.calls[0]?.args.slice(-2)).toEqual(["tab", "list"]);
  });
});
