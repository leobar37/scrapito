import type { Subprocess } from "bun";
import { AgentBrowserProcessError } from "../../domain/errors.ts";
import type { CommandExecutor, ExecOptions, ExecResult } from "./wire.ts";

/**
 * Default executor backed by Bun.spawn. Invokes the pinned agent-browser binary
 * with an explicit argument array (never shell interpolation) and optional stdin.
 */
export class BunCommandExecutor implements CommandExecutor {
  constructor(
    private readonly bin: string,
    private readonly baseEnv: Record<string, string> = {},
  ) {}

  async exec(args: string[], options: ExecOptions): Promise<ExecResult> {
    let proc: Subprocess<"ignore" | Uint8Array, "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.bin, ...args], {
        stdin: options.stdin != null ? new TextEncoder().encode(options.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...this.baseEnv },
      });
    } catch (err) {
      return {
        code: -1,
        stdout: "",
        stderr: "",
        spawnError: err instanceof Error ? err : new AgentBrowserProcessError(String(err)),
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeoutMs);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}
