import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { InvocationContext } from "@scrapito/contracts";
import { AgentRuntimeError } from "./errors.ts";
import { FixedIngestSubprocess, INGEST_ARGV } from "./ingest-subprocess.ts";

const invocation: InvocationContext = {
  schemaVersion: 1,
  invocationId: "run-1",
  intent: "acquire",
  site: "ripley-pe",
  strategy: "category",
  target: { kind: "category", externalId: "televisores" },
  constraints: {},
  repairPolicy: { allowRepair: false },
};

function validIngestResultLine(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    status: "completed",
    site: invocation.site,
    strategy: invocation.strategy,
    capability: invocation.intent,
    run: null,
    coverage: null,
    artifacts: [],
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
  })}\n`;
}

function fakeSpawn(stdoutText: string, stderrText = "") {
  return {
    stdin: { write: () => {}, end: () => {} },
    stdout: new Blob([stdoutText]).stream(),
    stderr: new Blob([stderrText]).stream(),
    exited: Promise.resolve(0),
  };
}

describe("INGEST_ARGV", () => {
  test("is the single fixed command scrap-agent may ever spawn", () => {
    expect(INGEST_ARGV).toEqual(["bun", "run", "ingest", "--", "target", "run", "-"]);
    expect(INGEST_ARGV.join(" ")).toBe("bun run ingest -- target run -");
  });

  test("is frozen so no caller can splice in an extra argument", () => {
    expect(Object.isFrozen(INGEST_ARGV)).toBe(true);
  });
});

describe("FixedIngestSubprocess.execute", () => {
  let spawnSpy: { mockRestore: () => void } | undefined;

  afterEach(() => {
    // Restore the real Bun.spawn between tests so unrelated subprocess use
    // in this or later files is never routed through a stale mock.
    spawnSpy?.mockRestore();
    spawnSpy = undefined;
  });

  test("always spawns exactly INGEST_ARGV, independent of the invocation's site, strategy, or target", () => {
    let capturedArgv: unknown;
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: unknown) => {
      capturedArgv = argv;
      return fakeSpawn(validIngestResultLine()) as never;
    });

    const executor = new FixedIngestSubprocess("/tmp/does-not-matter");
    void executor.execute(invocation, new AbortController().signal);

    expect(capturedArgv).toEqual([...INGEST_ARGV]);
  });

  test("parses a single well-formed stdout JSON line into an InvocationResult", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn(validIngestResultLine()) as never);

    const executor = new FixedIngestSubprocess("/tmp/does-not-matter");
    const result = await executor.execute(invocation, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.invocationId).toBe(invocation.invocationId);
  });

  test("rejects with BAD_INGEST_OUTPUT when the subprocess emits zero JSON lines", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn("\n\n") as never);

    const executor = new FixedIngestSubprocess("/tmp/does-not-matter");
    let caught: unknown;
    try {
      await executor.execute(invocation, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe("BAD_INGEST_OUTPUT");
  });

  test("rejects with BAD_INGEST_OUTPUT when the subprocess emits more than one JSON line", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() =>
      fakeSpawn(`${validIngestResultLine()}${validIngestResultLine()}`) as never,
    );

    const executor = new FixedIngestSubprocess("/tmp/does-not-matter");
    let caught: unknown;
    try {
      await executor.execute(invocation, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe("BAD_INGEST_OUTPUT");
  });

  test("rejects with BAD_INGEST_OUTPUT when the single line fails schema validation", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn('{"not":"a valid result"}\n') as never);

    const executor = new FixedIngestSubprocess("/tmp/does-not-matter");
    let caught: unknown;
    try {
      await executor.execute(invocation, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe("BAD_INGEST_OUTPUT");
  });

  test("throws the abort reason immediately without spawning when the signal is already aborted", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn(validIngestResultLine()) as never);
    const controller = new AbortController();
    controller.abort(new Error("cancelled upstream"));

    const executor = new FixedIngestSubprocess("/tmp/does-not-matter");
    await expect(executor.execute(invocation, controller.signal)).rejects.toThrow("cancelled upstream");
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
