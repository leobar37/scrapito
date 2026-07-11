/**
 * Verified agent-browser@0.31.1 JSON wire contracts. See
 * `src/browser/__fixtures__/agent-browser-contract.json` for captured
 * samples produced by `scripts/probe-agent-browser.ts`.
 */

/** Single-command JSON envelope. `error` is `null` on success. */
export interface SingleEnvelope<T = unknown> {
  success: boolean;
  data?: T | null;
  error?: string | null;
  warning?: string | null;
  type?: string;
}

/** One entry in a batch JSON envelope. Note the payload field is `result`. */
export interface BatchEntry<T = unknown> {
  command: string[];
  success: boolean;
  result?: T | null;
  error?: string | null;
}

/** Raw process execution result from the command executor. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process was killed for exceeding the timeout. */
  timedOut?: boolean;
  /** Set when the process failed to spawn at all. */
  spawnError?: Error;
}

export interface ExecOptions {
  stdin?: string;
  timeoutMs: number;
}

/** Injectable command executor so tests can supply recorded output. */
export interface CommandExecutor {
  exec(args: string[], options: ExecOptions): Promise<ExecResult>;
}

/** Shape of a tab entry inside `tab list` -> data.tabs. */
export interface WireTab {
  tabId: string;
  label: string | null;
  url: string;
  title?: string;
  type?: string;
  active: boolean;
}
