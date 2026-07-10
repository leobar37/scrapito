import { describe, expect, test } from "bun:test";
import { PolicyError } from "../domain/errors.ts";
import { CrawlPolicy } from "./crawl-policy.ts";
import { FakeClock } from "./clock.ts";
import { FakeHttpRouter, HONEST_UA, makeRobotsFetch } from "./testkit.ts";

const RIPLEY_HOST = "simple.ripley.com.pe";

function makePolicyWithRobots(byHost: Parameters<typeof makeRobotsFetch>[0]) {
  const clock = new FakeClock(0);
  const http = new FakeHttpRouter(clock);
  const { fetch: robotsFetch, calls } = makeRobotsFetch(byHost);
  const policy = new CrawlPolicy({
    userAgent: HONEST_UA,
    httpFetch: http.fetch,
    robotsFetch,
    clock,
    random: () => 0.5,
  });
  return { clock, policy, robotsCalls: calls };
}

describe("CrawlPolicy robots.txt enforcement", () => {
  test("longest-match rule wins: a more specific Allow overrides a broader Disallow", async () => {
    const { policy } = makePolicyWithRobots({
      [RIPLEY_HOST]: {
        status: 200,
        body: "User-agent: *\nDisallow: /api/\nAllow: /api/public/\n",
      },
    });
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/api/public/catalog`)).resolves
      .toBeDefined();
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/api/private/catalog`)).rejects
      .toThrow(PolicyError);
  });

  test("a plain Disallow for a path denies it while an unmentioned path is allowed", async () => {
    const { policy } = makePolicyWithRobots({
      [RIPLEY_HOST]: { status: 200, body: "User-agent: *\nDisallow: /internal/\n" },
    });
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/product/1`)).resolves.toBeDefined();
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/internal/secret`)).rejects.toThrow(
      PolicyError,
    );
  });

  test("4xx robots response is treated as permissive for ordinary paths", async () => {
    const { policy } = makePolicyWithRobots({
      [RIPLEY_HOST]: { status: 404, body: "not found" },
    });
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/product/1`)).resolves.toBeDefined();
  });

  test("4xx robots permissiveness does not lift the hard-coded safety floor", async () => {
    const { policy } = makePolicyWithRobots({
      [RIPLEY_HOST]: { status: 404, body: "not found" },
    });
    await expect(
      policy.assertAllowed(`https://${RIPLEY_HOST}/escribe-tu-review/123`),
    ).rejects.toThrow(PolicyError);
  });

  test("5xx robots response fails closed (denies everything for that host)", async () => {
    const { policy } = makePolicyWithRobots({
      [RIPLEY_HOST]: { status: 503, body: "server error" },
    });
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/product/1`)).rejects.toThrow(
      PolicyError,
    );
  });

  test("an unreachable robots fetch (network error) fails closed", async () => {
    const { policy } = makePolicyWithRobots({
      [RIPLEY_HOST]: new Error("ECONNREFUSED"),
    });
    await expect(policy.assertAllowed(`https://${RIPLEY_HOST}/product/1`)).rejects.toThrow(
      PolicyError,
    );
  });

  test("robots.txt is cached for 24h: a second lookup inside the window skips refetching", async () => {
    const { policy, robotsCalls, clock } = makePolicyWithRobots({
      [RIPLEY_HOST]: { status: 200, body: "User-agent: *\nAllow: /\n" },
    });
    await policy.assertAllowed(`https://${RIPLEY_HOST}/product/1`);
    expect(robotsCalls.length).toBe(1);

    await clock.advance(23 * 60 * 60 * 1000 + 59 * 60 * 1000); // 23h59m later
    await policy.assertAllowed(`https://${RIPLEY_HOST}/product/2`);
    expect(robotsCalls.length).toBe(1);

    await clock.advance(60 * 1000); // crosses the 24h boundary
    await policy.assertAllowed(`https://${RIPLEY_HOST}/product/3`);
    expect(robotsCalls.length).toBe(2);
  });

  test("robots.txt is refetched independently per host", async () => {
    const { policy, robotsCalls } = makePolicyWithRobots({
      [RIPLEY_HOST]: { status: 200, body: "User-agent: *\nAllow: /\n" },
      "www.falabella.com.pe": { status: 200, body: "User-agent: *\nAllow: /\n" },
    });
    await policy.assertAllowed(`https://${RIPLEY_HOST}/product/1`);
    await policy.assertAllowed("https://www.falabella.com.pe/falabella-pe/product/1");
    expect(robotsCalls.length).toBe(2);
  });
});
