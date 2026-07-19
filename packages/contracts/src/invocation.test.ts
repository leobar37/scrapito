import { describe, expect, test } from "bun:test";
import { INVOCATION_SCHEMA_VERSION, InvocationContextSchema, InvocationResultSchema } from "./invocation.ts";

const validCategoryContext = {
  schemaVersion: INVOCATION_SCHEMA_VERSION,
  invocationId: "run-1",
  intent: "acquire",
  site: "ripley-pe",
  strategy: "category",
  target: { kind: "category", externalId: "televisores" },
} as const;

const validSearchContext = {
  schemaVersion: INVOCATION_SCHEMA_VERSION,
  invocationId: "run-2",
  intent: "acquire",
  site: "falabella-pe",
  strategy: "search",
  target: { kind: "search", query: "laptop" },
} as const;

const baseUsage = {
  requests: 0,
  durationMs: 0,
  writerDurationMs: 0,
  productsSaved: 0,
  productsSeen: 0,
  productsRejected: 0,
  duplicatesSeen: 0,
  imagesDownloaded: 0,
  llm: null,
} as const;

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: INVOCATION_SCHEMA_VERSION,
    invocationId: "run-1",
    status: "completed",
    site: "ripley-pe",
    strategy: "category",
    capability: "acquire",
    run: null,
    coverage: null,
    artifacts: [],
    usage: baseUsage,
    error: null,
    ...overrides,
  };
}

describe("InvocationContextSchema: valid manifests", () => {
  test("accepts a minimal category manifest, defaulting constraints and repairPolicy", () => {
    const parsed = InvocationContextSchema.parse(validCategoryContext);
    expect(parsed.constraints).toEqual({});
    expect(parsed.repairPolicy).toEqual({ allowRepair: false });
  });

  test("accepts a minimal search manifest", () => {
    const parsed = InvocationContextSchema.parse(validSearchContext);
    expect(parsed.target).toEqual({ kind: "search", query: "laptop" });
  });
});

describe("InvocationContextSchema: strict unknown fields", () => {
  test("rejects an unrecognized top-level field", () => {
    expect(InvocationContextSchema.safeParse({ ...validCategoryContext, foo: "bar" }).success).toBe(false);
  });

  test.each([
    ["dueAt", { dueAt: "2026-07-18T00:00:00.000Z" }],
    ["retry", { retry: { attempts: 1 } }],
    ["batchId", { batchId: "batch-1" }],
    ["priority", { priority: 5 }],
    ["scheduledAt", { scheduledAt: "2026-07-18T00:00:00.000Z" }],
    ["queueState", { queueState: "queued" }],
    ["enabled", { enabled: true }],
    ["cadence", { cadence: "hourly" }],
  ])("rejects scheduler-owned %s field on an otherwise-valid manifest", (_name, extra) => {
    expect(InvocationContextSchema.safeParse({ ...validCategoryContext, ...extra }).success).toBe(false);
  });
});

describe("InvocationContextSchema: invalid enum members", () => {
  test("rejects an unknown intent", () => {
    expect(InvocationContextSchema.safeParse({ ...validCategoryContext, intent: "delete" }).success).toBe(false);
  });

  test("rejects an unknown site", () => {
    expect(InvocationContextSchema.safeParse({ ...validCategoryContext, site: "amazon-pe" }).success).toBe(false);
  });

  test("rejects an unknown strategy", () => {
    expect(InvocationContextSchema.safeParse({ ...validCategoryContext, strategy: "wishlist" }).success).toBe(false);
  });

  test("rejects a target with an unrecognized kind", () => {
    expect(
      InvocationContextSchema.safeParse({ ...validCategoryContext, target: { kind: "wishlist" } }).success,
    ).toBe(false);
  });
});

describe("InvocationContextSchema: strategy/target coherence", () => {
  test("rejects a category strategy paired with a product target", () => {
    const result = InvocationContextSchema.safeParse({
      ...validCategoryContext,
      target: { kind: "product", externalId: "sku-1" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "target.kind")).toBe(true);
    }
  });

  test("rejects a search strategy paired with a homepage target", () => {
    expect(
      InvocationContextSchema.safeParse({ ...validSearchContext, target: { kind: "homepage" } }).success,
    ).toBe(false);
  });
});

describe("InvocationContextSchema: category path/URL injection", () => {
  test.each([
    ["leading slash", "/televisores"],
    ["absolute URL", "https://evil.example.com/televisores"],
    ["scheme-relative", "//evil.example.com/televisores"],
    ["query string", "televisores?x=1"],
    ["hash fragment", "televisores#frag"],
    ["backslash", "televisores\\x"],
  ])("rejects category externalId with %s", (_name, externalId) => {
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        target: { kind: "category", externalId },
      }).success,
    ).toBe(false);
  });

  test("accepts a plain relative category externalId", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        target: { kind: "category", externalId: "electrohogar/televisores" },
      }).success,
    ).toBe(true);
  });
});

describe("InvocationContextSchema: product canonical host must match site", () => {
  const productBase = {
    schemaVersion: INVOCATION_SCHEMA_VERSION,
    invocationId: "run-3",
    intent: "acquire",
    strategy: "product",
  } as const;

  test("rejects a ripley site with a falabella canonical host", () => {
    const result = InvocationContextSchema.safeParse({
      ...productBase,
      site: "ripley-pe",
      target: { kind: "product", canonicalUrl: "https://www.falabella.com.pe/falabella-pe/product/1" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "target.canonicalUrl")).toBe(true);
    }
  });

  test("accepts a falabella site with a matching falabella canonical host", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...productBase,
        site: "falabella-pe",
        target: { kind: "product", canonicalUrl: "https://www.falabella.com.pe/falabella-pe/product/1" },
      }).success,
    ).toBe(true);
  });

  test("skips the host check for a product target identified by externalId", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...productBase,
        site: "ripley-pe",
        target: { kind: "product", externalId: "sku-42" },
      }).success,
    ).toBe(true);
  });
});

describe("InvocationContextSchema: page range validation", () => {
  test("rejects a range whose from exceeds to", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        constraints: { pages: { from: 5, to: 2 } },
      }).success,
    ).toBe(false);
  });

  test("rejects a range spanning more than 100 pages", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        constraints: { pages: { from: 1, to: 101 } },
      }).success,
    ).toBe(false);
  });

  test("rejects an explicit page list with more than 100 entries", () => {
    const pages = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(
      InvocationContextSchema.safeParse({ ...validCategoryContext, constraints: { pages } }).success,
    ).toBe(false);
  });

  test("accepts a range of exactly 100 pages at the boundary", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        constraints: { pages: { from: 1, to: 100 } },
      }).success,
    ).toBe(true);
  });
});

describe("InvocationContextSchema: repairPolicy is scoped to repair intent", () => {
  test("rejects allowRepair on a non-repair intent", () => {
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        intent: "acquire",
        repairPolicy: { allowRepair: true },
      }).success,
    ).toBe(false);
  });

  test("accepts only a hash-bound reproduction on an explicit repair intent", () => {
    const repairPolicy = {
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
    };
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        intent: "repair",
        repairPolicy,
      }).success,
    ).toBe(true);
    expect(
      InvocationContextSchema.safeParse({
        ...validCategoryContext,
        intent: "repair",
        repairPolicy: { allowRepair: true },
      }).success,
    ).toBe(false);
  });

  test("defaults allowRepair to false when repairPolicy is omitted", () => {
    const parsed = InvocationContextSchema.parse(validCategoryContext);
    expect(parsed.repairPolicy.allowRepair).toBe(false);
  });
});

describe("InvocationResultSchema: error presence is tied to status", () => {
  test.each(["failed", "rejected"] as const)("rejects a %s status without an error", (status) => {
    expect(InvocationResultSchema.safeParse(validResult({ status, error: null })).success).toBe(false);
  });

  test.each(["completed", "partial"] as const)("rejects a %s status carrying an error", (status) => {
    expect(
      InvocationResultSchema.safeParse(
        validResult({ status, error: { code: "E_BOOM", message: "boom" } }),
      ).success,
    ).toBe(false);
  });

  test.each(["failed", "rejected"] as const)("accepts a %s status with an error", (status) => {
    expect(
      InvocationResultSchema.safeParse(
        validResult({ status, error: { code: "E_BOOM", message: "boom" } }),
      ).success,
    ).toBe(true);
  });

  test.each(["completed", "partial"] as const)("accepts a %s status without an error", (status) => {
    expect(InvocationResultSchema.safeParse(validResult({ status, error: null })).success).toBe(true);
  });
});

describe("InvocationResultSchema: observed capacity metrics", () => {
  test("accepts stable request/time/product/duplicate/rejection coverage counters", () => {
    const parsed = InvocationResultSchema.parse(
      validResult({
        run: {
          runId: 1,
          scraperId: "ripley-pe-products",
          status: "completed",
          startedAt: "2026-07-18T00:00:00.000Z",
          finishedAt: "2026-07-18T00:00:01.000Z",
        },
        coverage: {
          coverageId: 1,
          status: "complete",
          authoritative: true,
          boundary: { kind: "requested_pages", pages: [1] },
          requests: 3,
          productsSeen: 8,
          duplicatesSeen: 2,
          productsRejected: 1,
          stopReason: "completed",
        },
        usage: {
          ...baseUsage,
          requests: 3,
          durationMs: 1_000,
          writerDurationMs: 25,
          productsSaved: 10,
          productsSeen: 8,
          duplicatesSeen: 2,
          productsRejected: 1,
        },
      }),
    );
    expect(parsed.coverage).toMatchObject({
      requests: 3,
      productsSeen: 8,
      duplicatesSeen: 2,
      productsRejected: 1,
    });
    expect(parsed.usage).toMatchObject({
      durationMs: 1_000,
      writerDurationMs: 25,
      productsSaved: 10,
      productsSeen: 8,
    });
  });
});

describe("InvocationResultSchema: strict fields, no scheduling leakage", () => {
  test("rejects an unrecognized top-level field", () => {
    expect(InvocationResultSchema.safeParse(validResult({ foo: "bar" })).success).toBe(false);
  });

  test.each([
    ["dueAt", { dueAt: "2026-07-18T00:00:00.000Z" }],
    ["retry", { retry: { attempts: 1 } }],
    ["batchId", { batchId: "batch-1" }],
    ["priority", { priority: 5 }],
    ["scheduledAt", { scheduledAt: "2026-07-18T00:00:00.000Z" }],
  ])("rejects scheduler-owned %s field on an otherwise-valid result", (_name, extra) => {
    expect(InvocationResultSchema.safeParse(validResult(extra)).success).toBe(false);
  });
});
