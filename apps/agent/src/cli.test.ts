import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InvocationResultSchema } from "@scrapito/contracts";

const repoRoot = resolve(import.meta.dir, "../../..");
const cliPath = resolve(import.meta.dir, "cli.ts");

const validManifest = {
  schemaVersion: 1,
  invocationId: "cli-run-1",
  intent: "acquire",
  site: "ripley-pe",
  strategy: "category",
  target: { kind: "category", externalId: "televisores" },
};

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], stdin?: string): Promise<CliRun> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: repoRoot,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env },
  });
  if (stdin !== undefined) {
    const writer = proc.stdin;
    if (!writer) throw new Error("CLI stdin pipe was not created");
    writer.write(stdin);
    writer.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function stdoutJsonLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

describe("scrap-agent CLI: --dry-run runs with no credentials or side effects", () => {
  test("manifest piped over stdin produces exactly one stdout line parsing as an InvocationResult", async () => {
    const { stdout, exitCode } = await runCli(["invoke", "-", "--dry-run"], JSON.stringify(validManifest));
    const lines = stdoutJsonLines(stdout);
    expect(lines).toHaveLength(1);
    const result = InvocationResultSchema.parse(JSON.parse(lines[0]!));
    expect(result.invocationId).toBe(validManifest.invocationId);
    expect(exitCode).toBe(0);
  });

  test("manifest supplied as a file argument produces exactly one stdout line parsing as an InvocationResult", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scrap-agent-cli-"));
    try {
      const file = join(dir, "manifest.json");
      await writeFile(file, JSON.stringify(validManifest));
      const { stdout, exitCode } = await runCli(["invoke", file, "--dry-run"]);
      const lines = stdoutJsonLines(stdout);
      expect(lines).toHaveLength(1);
      const result = InvocationResultSchema.parse(JSON.parse(lines[0]!));
      expect(result.invocationId).toBe(validManifest.invocationId);
      expect(exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scrap-agent CLI: --fake runs the deterministic runner and executor", () => {
  test("manifest piped over stdin produces exactly one stdout line parsing as an InvocationResult", async () => {
    const { stdout, exitCode } = await runCli(["invoke", "-", "--fake"], JSON.stringify(validManifest));
    const lines = stdoutJsonLines(stdout);
    expect(lines).toHaveLength(1);
    const result = InvocationResultSchema.parse(JSON.parse(lines[0]!));
    expect(result.invocationId).toBe(validManifest.invocationId);
    expect(exitCode).toBe(0);
  });

  test("manifest supplied as a file argument produces exactly one stdout line parsing as an InvocationResult", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scrap-agent-cli-"));
    try {
      const file = join(dir, "manifest.json");
      await writeFile(file, JSON.stringify(validManifest));
      const { stdout, exitCode } = await runCli(["invoke", file, "--fake"]);
      const lines = stdoutJsonLines(stdout);
      expect(lines).toHaveLength(1);
      const result = InvocationResultSchema.parse(JSON.parse(lines[0]!));
      expect(result.invocationId).toBe(validManifest.invocationId);
      expect(exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
