import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runScraperCanary } from "./canary.ts";

const SHA256 = /^[a-f0-9]{64}$/;

describe("registered scraper temporary canary", () => {
  test("loads the static registry checkout and produces reproducible fixture evidence", async () => {
    const first = await runScraperCanary("ripley-pe-products");
    const second = await runScraperCanary("ripley-pe-products");
    const registrySource = await Bun.file(join(import.meta.dir, "registry.ts")).text();
    expect(first.ok).toBe(true);
    expect(first.code).toBe("SCRAPER_CANARY_PASSED");
    expect(first.products).toBeGreaterThan(0);
    expect(first.valid).toBe(first.products);
    expect(first.checkoutSha256).toBe(createHash("sha256").update(registrySource).digest("hex"));
    expect(first.productsSha256).toMatch(SHA256);
    expect(first.resultSha256).toBe(second.resultSha256);
  });

  test("rejects ids absent from the static registry without dynamic module loading", async () => {
    const result = await runScraperCanary("../../arbitrary-module");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SCRAPER_CANARY_FAILED");
    expect(result.error).toContain("unknown statically registered scraper");
    expect(result.resultSha256).toMatch(SHA256);
  });
});
