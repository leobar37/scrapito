/**
 * scripts/probe-agent-browser.ts
 *
 * Probes the pinned agent-browser binary and asserts its JSON wire contracts,
 * then writes sanitized fixtures used by the adapter contract tests. Run via
 * `bun run browser:probe`. A deliberate version bump must update these fixtures.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN = join(ROOT, "node_modules", ".bin", "agent-browser");
const SESSION = "contract-probe";
const FIXTURE_DIR = join(ROOT, "src", "sdk", "browser", "__fixtures__");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  const proc = spawnSync(BIN, args, { encoding: "utf8", timeout: 30_000 });
  return {
    code: proc.status ?? -1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`probe assertion failed: ${msg}`);
}

/** Remove environment-specific noise so fixtures are stable across machines. */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "lifecycle") {
        out[k] = "<lifecycle>";
        continue;
      }
      if (k === "launchHash") {
        out[k] = 0;
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

function main(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  try {
    // 1. Single-command envelope: open the probe page.
    const open = run([
      "--session",
      SESSION,
      "--json",
      "open",
      "data:text/html,<title>probe</title>",
    ]);
    const openJson = JSON.parse(open.stdout) as Record<string, unknown>;
    assert(openJson.success === true, "open should succeed");
    assert("data" in openJson, "single envelope has data");
    assert("error" in openJson, "single envelope has error field");

    // 2. Batch envelope: two commands with --bail.
    const batch = run([
      "--session",
      SESSION,
      "--json",
      "batch",
      "--bail",
      "get title",
      "get url",
    ]);
    const batchJson = JSON.parse(batch.stdout) as Array<Record<string, unknown>>;
    assert(Array.isArray(batchJson), "batch envelope is an array");
    assert(batchJson.length === 2, "batch has two entries");
    for (const entry of batchJson) {
      assert(Array.isArray(entry.command), "batch entry has command array");
      assert(typeof entry.success === "boolean", "batch entry has success");
      assert("result" in entry, "batch entry uses `result` not `data`");
    }

    // 3. Failure envelope: valid JSON with exit code 1.
    const fail = run(["--session", SESSION, "--json", "click", "#nonexistent-xyz"]);
    const failJson = JSON.parse(fail.stdout) as Record<string, unknown>;
    assert(fail.code === 1, "failure exits non-zero");
    assert(failJson.success === false, "failure envelope success=false");
    assert(typeof failJson.error === "string", "failure envelope has error string");

    // 4. Tab listing shape.
    const tabs = run(["--session", SESSION, "--json", "tab", "list"]);
    const tabsJson = JSON.parse(tabs.stdout) as {
      data: { tabs: Array<Record<string, unknown>> };
    };
    assert(Array.isArray(tabsJson.data.tabs), "tab list has data.tabs array");
    const firstTab = tabsJson.data.tabs[0];
    assert(firstTab !== undefined, "at least one tab");
    assert(typeof firstTab.tabId === "string", "tab has tabId");
    assert("label" in firstTab, "tab has label field");
    assert("active" in firstTab, "tab has active field");

    const fixtures = {
      version: "0.31.1",
      capturedAt: new Date().toISOString().slice(0, 10),
      single: {
        success: sanitize(openJson),
        failure: sanitize(failJson),
      },
      batch: sanitize(batchJson),
      tabList: sanitize(tabsJson),
    };
    const outPath = join(FIXTURE_DIR, "agent-browser-contract.json");
    writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + "\n");
    console.log(`probe OK: fixtures written to ${outPath}`);
  } finally {
    run(["--session", SESSION, "close"]);
  }
}

main();
