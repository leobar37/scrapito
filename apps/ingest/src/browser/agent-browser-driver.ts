/**
 * AgentBrowserDriver — the subprocess protocol seam around the pinned
 * agent-browser CLI. Maps the verified JSON wire contracts to typed results
 * and distinguishes browser/domain failures from process failures.
 *
 * Contract (agent-browser@0.31.1):
 *  - single command  : { success, data?, error?, warning?, type? }
 *  - batch command   : [{ command, success, result?, error? }]
 *  - a non-zero exit WITH a valid failure envelope is a domain result
 *  - spawn failure, timeout without JSON, or malformed stdout throws
 *    AgentBrowserProcessError
 */
import {
  AgentBrowserCommandError,
  AgentBrowserProcessError,
} from "@scrapito/contracts";
import { BunCommandExecutor } from "./bun-executor.ts";
import type {
  BatchEntry,
  CommandExecutor,
  SingleEnvelope,
  WireTab,
} from "./wire.ts";

export interface DriverOptions {
  session: string;
  bin: string;
  timeoutMs: number;
  restoreKey?: string;
  headless?: boolean;
  userAgent?: string;
  browserArgs?: string[];
  executor?: CommandExecutor;
}

export class AgentBrowserDriver {
  private readonly session: string;
  private readonly timeoutMs: number;
  private readonly restoreKey?: string;
  private readonly headless: boolean;
  private readonly userAgent?: string;
  private readonly browserArgs: string[];
  private readonly executor: CommandExecutor;

  constructor(options: DriverOptions) {
    this.session = options.session;
    this.timeoutMs = options.timeoutMs;
    this.restoreKey = options.restoreKey;
    this.headless = options.headless ?? true;
    this.userAgent = options.userAgent;
    this.browserArgs =
      options.browserArgs ??
      (process.env.AGENT_BROWSER_ARGS
        ? process.env.AGENT_BROWSER_ARGS.split(",").map((s) => s.trim()).filter(Boolean)
        : []);
    this.executor = options.executor ?? new BunCommandExecutor(options.bin);
  }

  get sessionName(): string {
    return this.session;
  }

  /** Global flags prepended to every invocation. */
  private globalFlags(): string[] {
    const flags = ["--session", this.session, "--json"];
    if (this.restoreKey) flags.push("--restore", this.restoreKey);
    if (this.userAgent) flags.push("--user-agent", this.userAgent);
    if (this.browserArgs.length > 0) flags.push("--args", this.browserArgs.join(","));
    if (this.headless === false) flags.push("--headed");
    return flags;
  }

  private tryParse(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  /**
   * Run a single JSON command. Returns `data` on success. Throws
   * AgentBrowserCommandError on a valid failure envelope and
   * AgentBrowserProcessError otherwise.
   */
  async runJson<T = unknown>(command: readonly string[]): Promise<T> {
    const args = [...this.globalFlags(), ...command];
    const res = await this.executor.exec(args, { timeoutMs: this.timeoutMs });

    if (res.spawnError) {
      throw new AgentBrowserProcessError(
        `failed to spawn agent-browser: ${res.spawnError.message}`,
        { command },
      );
    }

    const parsed = this.tryParse(res.stdout);
    if (parsed === undefined) {
      if (res.timedOut) {
        throw new AgentBrowserProcessError(
          `agent-browser timed out after ${this.timeoutMs}ms with no JSON`,
          { command, stderr: res.stderr },
        );
      }
      throw new AgentBrowserProcessError("malformed agent-browser stdout", {
        command,
        code: res.code,
        stdout: res.stdout.slice(0, 500),
        stderr: res.stderr.slice(0, 500),
      });
    }

    if (Array.isArray(parsed) || typeof parsed !== "object") {
      throw new AgentBrowserProcessError(
        "expected single-command envelope, got array/non-object",
        { command, parsed },
      );
    }

    const env = parsed as SingleEnvelope<T>;
    if (env.success === true) {
      return (env.data ?? undefined) as T;
    }
    throw new AgentBrowserCommandError(env.error ?? "agent-browser command failed", {
      command,
      envelope: env,
    });
  }

  /**
   * Run a fixed batch recipe. Each element is a full command line string.
   * Returns the raw batch entries; callers inspect per-entry `success`/`result`.
   * A process-level failure (spawn/timeout/malformed) throws.
   */
  async runBatch<T = unknown>(
    commandLines: readonly string[],
    options: { bail?: boolean } = {},
  ): Promise<BatchEntry<T>[]> {
    const args = [...this.globalFlags(), "batch"];
    if (options.bail !== false) args.push("--bail");
    args.push(...commandLines);
    const res = await this.executor.exec(args, { timeoutMs: this.timeoutMs });

    if (res.spawnError) {
      throw new AgentBrowserProcessError(
        `failed to spawn agent-browser: ${res.spawnError.message}`,
        { commandLines },
      );
    }

    const parsed = this.tryParse(res.stdout);
    if (parsed === undefined) {
      if (res.timedOut) {
        throw new AgentBrowserProcessError(
          `agent-browser batch timed out after ${this.timeoutMs}ms with no JSON`,
          { commandLines, stderr: res.stderr },
        );
      }
      throw new AgentBrowserProcessError("malformed agent-browser batch stdout", {
        commandLines,
        stdout: res.stdout.slice(0, 500),
      });
    }
    if (!Array.isArray(parsed)) {
      throw new AgentBrowserProcessError(
        "expected batch envelope array, got object",
        { commandLines, parsed },
      );
    }
    return parsed as BatchEntry<T>[];
  }

  /** List tabs via `tab list`, returning the normalized WireTab array. */
  async listTabs(): Promise<WireTab[]> {
    const data = await this.runJson<{ tabs: WireTab[] }>(["tab", "list"]);
    return data.tabs ?? [];
  }

  /** Open a new tab (optionally navigating), returning its stable tabId. */
  async newTab(url?: string): Promise<string> {
    const cmd = url ? ["tab", "new", url] : ["tab", "new"];
    const data = await this.runJson<{ tabId: string }>(cmd);
    return data.tabId;
  }

  /** Switch the active tab by stable tabId. */
  async switchTab(tabId: string): Promise<void> {
    await this.runJson(["tab", tabId]);
  }

  /** Close a tab by stable tabId. */
  async closeTab(tabId: string): Promise<void> {
    await this.runJson(["tab", "close", tabId]);
  }

  /** Navigate the active tab. */
  async open(url: string): Promise<void> {
    await this.runJson(["open", url]);
  }

  /** Read the active tab's rendered HTML. */
  async getHtml(): Promise<string> {
    const data = await this.runJson<{ html?: string } | string>(["get", "html", "html"]);
    if (typeof data === "string") return data;
    return data.html ?? "";
  }

  /** Evaluate JS in the active tab (discovery-only). */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const data = await this.runJson<{ result: T }>(["eval", expression]);
    return data.result;
  }

  /** Close the whole session's browser. */
  async close(): Promise<void> {
    await this.runJson(["close"]);
  }
}
