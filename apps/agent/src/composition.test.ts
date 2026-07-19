import { describe, expect, test } from "bun:test";
import { composeInvocation } from "./composition.ts";
import { AgentRuntimeError } from "./errors.ts";

const SCHEMA_VERSION = 1 as const;

function categoryInvocation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    invocationId: "run-category",
    intent: "acquire",
    site: "ripley-pe",
    strategy: "category",
    target: { kind: "category", externalId: "televisores" },
    ...overrides,
  };
}

describe("composeInvocation: supported P-003 acquire matrix", () => {
  test.each([
    ["ripley-pe", "category", { kind: "category", externalId: "televisores" }],
    ["ripley-pe", "search", { kind: "search", query: "laptop" }],
    ["falabella-pe", "category", { kind: "category", externalId: "televisores" }],
    ["falabella-pe", "search", { kind: "search", query: "laptop" }],
    ["promart-pe", "category", { kind: "category", externalId: "refrigeracion" }],
    ["promart-pe", "search", { kind: "search", query: "laptop" }],
  ] as const)("composes %s/%s acquire with a non-empty evidence trail", (site, strategy, target) => {
    const composition = composeInvocation({
      schemaVersion: SCHEMA_VERSION,
      invocationId: `run-${site}-${strategy}`,
      intent: "acquire",
      site,
      strategy,
      target,
    });
    expect(composition.site.site).toBe(site);
    expect(composition.strategy.strategy).toBe(strategy);
    expect(composition.capability.capability).toBe("acquire");
    expect(composition.evidence.length).toBeGreaterThan(0);
    expect(composition.prompt.length).toBeGreaterThan(0);
  });
});

describe("composeInvocation: strict unknown-field rejection", () => {
  test("rejects a manifest carrying an unrecognized top-level field", () => {
    expect(() => composeInvocation({ ...categoryInvocation(), foo: "bar" })).toThrow();
  });

  test("rejects a manifest carrying a scheduler-owned field the one-shot manifest must not set", () => {
    expect(() => composeInvocation({ ...categoryInvocation(), scraperId: "ripley-pe-products" })).toThrow();
  });
});

describe("composeInvocation: unsupported matrix fail-fast", () => {
  test("rejects homepage acquire with UNSUPPORTED_INVOCATION, distinct from a schema error", () => {
    let caught: unknown;
    try {
      composeInvocation({
        schemaVersion: SCHEMA_VERSION,
        invocationId: "run-homepage",
        intent: "acquire",
        site: "ripley-pe",
        strategy: "homepage",
        target: { kind: "homepage" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe("UNSUPPORTED_INVOCATION");
  });

  test("rejects category inspect even though category acquire on the same site is supported", () => {
    let caught: unknown;
    try {
      composeInvocation({ ...categoryInvocation(), intent: "inspect" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect((caught as AgentRuntimeError).code).toBe("UNSUPPORTED_INVOCATION");
  });

  test("accepts explicit hash-bound repair on a verified repair cell", () => {
    const composition = composeInvocation({
      ...categoryInvocation(),
      intent: "repair",
      repairPolicy: {
        allowRepair: true,
        reproduction: {
          runRef: "run:123",
          runSha256: "a".repeat(64),
          evidenceId: "ripley-pe/__fixtures__/list.html",
          evidenceSha256: "b".repeat(64),
          expectedFailureSha256: "c".repeat(64),
          baselineCommit: "d".repeat(40),
          baselineTreeSha256: "e".repeat(64),
        },
      },
    });
    expect(composition.capability.capability).toBe("repair");
    expect(composition.evidence).toContain("ripley-pe/__fixtures__/list.html");
  });
});
