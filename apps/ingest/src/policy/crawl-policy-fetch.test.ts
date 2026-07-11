import { describe, expect, test } from "bun:test";
import { BudgetExhaustedError, PolicyError } from "@scrapito/contracts";
import { RequestBudget } from "./budget.ts";
import { FakeClock } from "./clock.ts";
import { CrawlPolicy } from "./crawl-policy.ts";
import { ALLOW_ALL_ROBOTS, FakeHttpRouter, HONEST_UA, drain } from "./testkit.ts";

const RIPLEY = "https://simple.ripley.com.pe";
const RIPLEY_IMG = "https://rimage.ripley.com.pe";

function makePolicy() {
  const clock = new FakeClock(0);
  const http = new FakeHttpRouter(clock);
  const policy = new CrawlPolicy({
    userAgent: HONEST_UA,
    httpFetch: http.fetch,
    robotsFetch: ALLOW_ALL_ROBOTS,
    clock,
    random: () => 0.5,
  });
  return { clock, http, policy };
}

describe("CrawlPolicy.fetch redirects", () => {
  test("follows up to 5 redirects and returns the final 200 response", async () => {
    const { policy, http } = makePolicy();
    http
      .queue(`${RIPLEY}/a`, { status: 302, headers: { location: `${RIPLEY}/b` }, body: "" })
      .queue(`${RIPLEY}/b`, { status: 302, headers: { location: `${RIPLEY}/c` }, body: "" })
      .queue(`${RIPLEY}/c`, { status: 302, headers: { location: `${RIPLEY}/d` }, body: "" })
      .queue(`${RIPLEY}/d`, { status: 302, headers: { location: `${RIPLEY}/e` }, body: "" })
      .queue(`${RIPLEY}/e`, { status: 302, headers: { location: `${RIPLEY}/f` }, body: "" })
      .queue(`${RIPLEY}/f`, { status: 200, headers: {}, body: "final content" });

    const response = await policy.fetch(`${RIPLEY}/a`);
    expect(response.status).toBe(200);
    expect(response.body).toBe("final content");
    expect(response.finalUrl).toBe(`${RIPLEY}/f`);
    // a,b,c,d,e,f = 5 redirect hops + the final fetch = 6 calls.
    expect(http.calls.length).toBe(6);
  });

  test("a 6th consecutive redirect exceeds the limit and throws PolicyError", async () => {
    const { policy, http } = makePolicy();
    http
      .queue(`${RIPLEY}/a`, { status: 302, headers: { location: `${RIPLEY}/b` }, body: "" })
      .queue(`${RIPLEY}/b`, { status: 302, headers: { location: `${RIPLEY}/c` }, body: "" })
      .queue(`${RIPLEY}/c`, { status: 302, headers: { location: `${RIPLEY}/d` }, body: "" })
      .queue(`${RIPLEY}/d`, { status: 302, headers: { location: `${RIPLEY}/e` }, body: "" })
      .queue(`${RIPLEY}/e`, { status: 302, headers: { location: `${RIPLEY}/f` }, body: "" })
      .queue(`${RIPLEY}/f`, { status: 302, headers: { location: `${RIPLEY}/g` }, body: "" });

    await expect(policy.fetch(`${RIPLEY}/a`)).rejects.toThrow(PolicyError);
  });

  test("a redirect leaving the allowlist is rejected without following it", async () => {
    const { policy, http } = makePolicy();
    http.queue(`${RIPLEY}/a`, {
      status: 302,
      headers: { location: "https://evil.example.com/steal" },
      body: "",
    });

    await expect(policy.fetch(`${RIPLEY}/a`)).rejects.toThrow(PolicyError);
    expect(http.countCalls(`${RIPLEY}/a`)).toBe(1);
    expect(http.countCalls("https://evil.example.com/steal")).toBe(0);
  });
});

describe("CrawlPolicy.fetch retry policy", () => {
  test.each([408, 425, 429, 500, 502, 503, 504])(
    "retries status %d up to 3 attempts, then throws",
    async (status) => {
      const { policy, http, clock } = makePolicy();
      http.setFallback({ status, headers: {}, body: "unavailable" });
      await expect(drain(clock, policy.fetch(`${RIPLEY}/retryable`))).rejects.toThrow(
        PolicyError,
      );
      expect(http.calls.length).toBe(3);
    },
  );

  test.each([403, 404])("does not retry non-retryable status %d", async (status) => {
    const { policy, http, clock } = makePolicy();
    http.setFallback({ status, headers: {}, body: "denied" });
    await expect(drain(clock, policy.fetch(`${RIPLEY}/blocked`))).rejects.toThrow(PolicyError);
    expect(http.calls.length).toBe(1);
  });

  test("honors Retry-After in seconds form and waits at least that long before the next attempt", async () => {
    const { policy, http, clock } = makePolicy();
    const start = clock.now();
    http
      .queue(`${RIPLEY}/paced`, {
        status: 429,
        headers: { "retry-after": "5" },
        body: "slow down",
      })
      .queue(`${RIPLEY}/paced`, { status: 200, headers: {}, body: "ok" });

    const response = await drain(clock, policy.fetch(`${RIPLEY}/paced`));
    expect(response.status).toBe(200);
    expect(http.calls.length).toBe(2);
    expect(clock.now() - start).toBeGreaterThanOrEqual(5000);
  });

  test("honors Retry-After in HTTP-date form and waits at least until that instant", async () => {
    const startEpoch = Date.now();
    const clock = new FakeClock(startEpoch);
    const http = new FakeHttpRouter(clock);
    const policy = new CrawlPolicy({
      userAgent: HONEST_UA,
      httpFetch: http.fetch,
      robotsFetch: ALLOW_ALL_ROBOTS,
      clock,
      random: () => 0.5,
    });
    const retryAtDate = new Date(startEpoch + 3000).toUTCString();
    http
      .queue(`${RIPLEY}/paced-date`, {
        status: 503,
        headers: { "retry-after": retryAtDate },
        body: "maintenance",
      })
      .queue(`${RIPLEY}/paced-date`, { status: 200, headers: {}, body: "ok" });

    const response = await drain(clock, policy.fetch(`${RIPLEY}/paced-date`));
    expect(response.status).toBe(200);
    expect(http.calls.length).toBe(2);
    expect(clock.now() - startEpoch).toBeGreaterThanOrEqual(3000);
  });
});

describe("CrawlPolicy.fetch conditional requests and caching", () => {
  test("a later fetch past freshness sends If-None-Match and a 304 yields notModified", async () => {
    const { policy, http, clock } = makePolicy();
    http.queue(`${RIPLEY}/product/1`, {
      status: 200,
      headers: { etag: '"abc123"' },
      body: "<html>product</html>",
    });
    const first = await policy.fetch(`${RIPLEY}/product/1`);
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"abc123"');

    // Advance past both the immediate freshness expiry (etag => freshUntil==fetchedAt)
    // and the per-host scheduler spacing (2250ms with random()=0.5) before the next fetch.
    await clock.advance(100);
    http.queue(`${RIPLEY}/product/1`, { status: 304, headers: {}, body: "" });
    const second = await drain(clock, policy.fetch(`${RIPLEY}/product/1`), { stepMs: 500 });

    expect(second.status).toBe(304);
    expect(second.notModified).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(second.etag).toBe('"abc123"');
    expect(second.bodyHash).toBe(first.bodyHash);

    const secondCall = http.calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall?.headers["if-none-match"]).toBe('"abc123"');
  });

  test("a 200 with no validators is not refetched within the 24h document freshness floor", async () => {
    const { policy, http, clock } = makePolicy();
    http.queue(`${RIPLEY}/product/2`, { status: 200, headers: {}, body: "<html>no etag</html>" });
    await policy.fetch(`${RIPLEY}/product/2`);
    expect(http.calls.length).toBe(1);

    await clock.advance(23 * 60 * 60 * 1000);
    const cached = await policy.fetch(`${RIPLEY}/product/2`);
    expect(http.calls.length).toBe(1); // no network call at all — served from the freshness floor
    expect(cached.notModified).toBe(true);
    expect(cached.fromCache).toBe(true);

    await clock.advance(2 * 60 * 60 * 1000); // now past the 24h floor
    http.queue(`${RIPLEY}/product/2`, { status: 200, headers: {}, body: "<html>updated</html>" });
    await policy.fetch(`${RIPLEY}/product/2`);
    expect(http.calls.length).toBe(2);
  });

  test("a 200 with no validators is not refetched within the 7d image freshness floor", async () => {
    const { policy, http, clock } = makePolicy();
    const imgUrl = `${RIPLEY_IMG}/full_image-1.webp`;
    http.queue(imgUrl, { status: 200, headers: {}, body: "binary-ish" });
    await policy.fetch(imgUrl, { class: "image" });
    expect(http.calls.length).toBe(1);

    await clock.advance(6 * 24 * 60 * 60 * 1000); // 6 days later, still within the 7d floor
    const cached = await policy.fetch(imgUrl, { class: "image" });
    expect(http.calls.length).toBe(1);
    expect(cached.notModified).toBe(true);

    await clock.advance(2 * 24 * 60 * 60 * 1000); // now past the 7d floor
    http.queue(imgUrl, { status: 200, headers: {}, body: "binary-ish-v2" });
    await policy.fetch(imgUrl, { class: "image" });
    expect(http.calls.length).toBe(2);
  });
});

describe("CrawlPolicy.fetch pacing and budgets", () => {
  test("enforces per-host spacing between successive requests to the same host", async () => {
    const { policy, http, clock } = makePolicy();
    http.setFallback({ status: 200, headers: {}, body: "ok" });

    const first = await policy.fetch(`${RIPLEY}/spacing/1`);
    expect(first.status).toBe(200);
    const firstCallAt = http.calls[0]?.at;
    expect(firstCallAt).toBe(0);

    const second = await drain(clock, policy.fetch(`${RIPLEY}/spacing/2`), { stepMs: 500 });
    expect(second.status).toBe(200);
    const secondCallAt = http.calls[1]?.at ?? -1;
    // random()=0.5 -> midpoint of the [1500,3000] document spacing window = 2250ms.
    expect(secondCallAt).toBeGreaterThanOrEqual(2250);
  });

  test("throws BudgetExhaustedError once the request budget is spent, without hitting the network", async () => {
    const { policy, http, clock } = makePolicy();
    http.setFallback({ status: 200, headers: {}, body: "ok" });
    const budget = new RequestBudget(1, 1_000_000, clock);

    const first = await policy.fetch(`${RIPLEY}/budget/1`, { budget });
    expect(first.status).toBe(200);
    expect(http.calls.length).toBe(1);

    await expect(policy.fetch(`${RIPLEY}/budget/2`, { budget })).rejects.toThrow(
      BudgetExhaustedError,
    );
    expect(http.countCalls(`${RIPLEY}/budget/2`)).toBe(0);
  });
});
