#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadAgentConfig } from "./config.ts";
import { DeterministicIngestExecutor, FixedIngestSubprocess } from "./ingest-subprocess.ts";
import { invokeOneShot, rejectedInvocationResult } from "./invocation.ts";
import { DeterministicSessionRunner, OmpAgentSessionRunner } from "./omp-session.ts";

interface CliOptions {
  file?: string;
  configPath?: string;
  dryRun: boolean;
  fake: boolean;
}

function parseArgs(args: string[]): CliOptions {
  if (args[0] !== "invoke") throw new Error("usage: scrap-agent invoke [file|-] [--config path] [--dry-run] [--fake]");
  const options: CliOptions = { dryRun: false, fake: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--fake") {
      options.fake = true;
    } else if (arg === "--config") {
      const path = args[++index];
      if (!path) throw new Error("--config requires a path");
      options.configPath = path;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.file === undefined) {
      options.file = arg;
    } else {
      throw new Error("only one manifest file is accepted");
    }
  }
  return options;
}

const root = resolve(import.meta.dir, "../../..");
let raw: unknown = {};
try {
  const options = parseArgs(process.argv.slice(2));
  const text = options.file && options.file !== "-" ? await Bun.file(options.file).text() : await Bun.stdin.text();
  raw = JSON.parse(text);
  const config = await loadAgentConfig(options.configPath);
  const execution = await invokeOneShot(raw, {
    config,
    sessionRunner: options.fake ? new DeterministicSessionRunner() : new OmpAgentSessionRunner(root),
    ingestExecutor: options.fake ? new DeterministicIngestExecutor() : new FixedIngestSubprocess(root),
    dryRun: options.dryRun,
  });
  console.log(JSON.stringify(execution.result));
  if (process.env.SCRAP_AGENT_AUDIT_STDERR === "1") {
    console.error(JSON.stringify({ type: "scrap-agent-audit", records: execution.audit }));
  }
  process.exitCode = execution.result.status === "failed" || execution.result.status === "rejected" ? 1 : 0;
} catch (error) {
  const result = rejectedInvocationResult(raw, error);
  console.log(JSON.stringify(result));
  process.exitCode = 1;
}
