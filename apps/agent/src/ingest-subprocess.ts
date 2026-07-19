import { InvocationResultSchema, type InvocationContext, type InvocationResult } from "@scrapito/contracts";
import { AgentRuntimeError } from "./errors.ts";
import type { IngestExecutor } from "./types.ts";

export const INGEST_ARGV = Object.freeze(["bun", "run", "ingest", "--", "target", "run", "-"] as const);

export class FixedIngestSubprocess implements IngestExecutor {
  constructor(private readonly cwd: string) {}

  async execute(invocation: InvocationContext, signal: AbortSignal): Promise<InvocationResult> {
    if (signal.aborted) throw signal.reason;
    const process = Bun.spawn([...INGEST_ARGV], {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal,
      env: { ...Bun.env },
    });
    process.stdin.write(`${JSON.stringify(invocation)}\n`);
    process.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== 1) {
      throw new AgentRuntimeError("BAD_INGEST_OUTPUT", "scrap-ingest must emit exactly one JSON line", {
        exitCode,
        stderr: stderr.trim(),
        lines: lines.length,
      });
    }

    try {
      return InvocationResultSchema.parse(JSON.parse(lines[0]!));
    } catch (error) {
      throw new AgentRuntimeError("BAD_INGEST_OUTPUT", error instanceof Error ? error.message : String(error), {
        exitCode,
        stderr: stderr.trim(),
      });
    }
  }
}

export class DeterministicIngestExecutor implements IngestExecutor {
  async execute(invocation: InvocationContext, signal: AbortSignal): Promise<InvocationResult> {
    if (signal.aborted) throw signal.reason;
    const now = new Date().toISOString();
    return InvocationResultSchema.parse({
      schemaVersion: 1,
      invocationId: invocation.invocationId,
      status: "completed",
      site: invocation.site,
      strategy: invocation.strategy,
      capability: invocation.intent,
      run: {
        runId: 1,
        scraperId: `fake-${invocation.site}`,
        status: "completed",
        startedAt: now,
        finishedAt: now,
      },
      coverage: null,
      artifacts: [{ kind: "fake_ingest", ref: `fake:${invocation.invocationId}`, sha256: null }],
      usage: {
        requests: 1,
        durationMs: 1,
        writerDurationMs: 1,
        productsSaved: 1,
        productsSeen: 1,
        productsRejected: 0,
        duplicatesSeen: 0,
        imagesDownloaded: 0,
        llm: null,
      },
      error: null,
    });
  }
}
