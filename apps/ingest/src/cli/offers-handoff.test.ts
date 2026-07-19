import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const CLI = resolve(import.meta.dir, "index.ts");
interface StoppableServer {
  stop(closeActiveConnections?: boolean): void;
}
const servers: StoppableServer[] = [];

async function runCli(args: string[]) {
  const process = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    env: { ...globalThis.process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function handoff(coverageId: number) {
  return {
    invocationId: "cli-invocation",
    runId: 4,
    site: "ripley-pe",
    coverage: {
      coverageId,
      status: "partial",
      authoritative: false,
      startedAt: "2026-07-18T10:00:00.000Z",
      finishedAt: "2026-07-18T10:00:01.000Z",
      boundary: { page: 1 },
      stopReason: "budget_exhausted",
    },
    data: [
      {
        productId: 1,
        storeId: "ripley-pe",
        externalId: "sku-1",
        name: "Product",
        brand: null,
        seller: { id: null, name: null },
        url: "https://simple.ripley.com.pe/sku-1",
        currency: "PEN",
        price: {
          observationId: 2,
          observedAt: "2026-07-18T10:00:00.000Z",
          regularCents: 1000,
          offerCents: null,
          cardCents: null,
          effectiveCents: 1000,
          access: "public",
          inStock: true,
        },
        movement: {
          previousObservationId: null,
          previousEffectiveCents: null,
          previousAccess: null,
          priorHistoricalLowCents: null,
          currentHistoricalLowCents: 1000,
          isPriceDrop: false,
          isHistoricalLow: false,
          sellerChanged: false,
        },
        evidence: {
          sightingId: 3,
          seenAt: "2026-07-18T10:00:00.000Z",
          coverageId,
          sourceHash: null,
        },
      },
    ],
    nextCursor: null,
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("scrap-ingest offers handoff", () => {
  test("calls the fake API with limit/cursor and emits exactly one schema-valid JSON line", async () => {
    const requested: { path: string | null; limit: string | null; cursor: string | null } = {
      path: null,
      limit: null,
      cursor: null,
    };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const requestedUrl = new URL(request.url);
        requested.path = requestedUrl.pathname;
        requested.limit = requestedUrl.searchParams.get("limit");
        requested.cursor = requestedUrl.searchParams.get("cursor");
        return Response.json(handoff(9));
      },
    });
    servers.push(server);

    const result = await runCli([
      "offers",
      "handoff",
      "9",
      "--limit",
      "1",
      "--cursor",
      "opaque-cursor",
      "--api-base-url",
      `http://127.0.0.1:${server.port}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(handoff(9));
    expect(requested.path).toBe("/coverages/9/offers");
    expect(requested.limit).toBe("1");
    expect(requested.cursor).toBe("opaque-cursor");
  });

  test("passes through one JSON API error and keeps offers query registered", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: { code: "COVERAGE_NOT_FOUND", message: "missing" } }, { status: 404 });
      },
    });
    servers.push(server);

    const failed = await runCli([
      "offers",
      "handoff",
      "999",
      "--api-base-url",
      `http://127.0.0.1:${server.port}`,
      "--json",
    ]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(failed.stdout)).toEqual({ error: { code: "COVERAGE_NOT_FOUND", message: "missing" } });

    const help = await runCli(["offers", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("handoff");
    expect(help.stdout).toContain("query");
  });
});
