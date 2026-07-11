import { describe, expect, test } from "bun:test";
import { ChallengeDetectedError, CircuitOpenError } from "@scrapito/contracts";
import { FakeClock } from "./clock.ts";
import { CrawlPolicy } from "./crawl-policy.ts";
import { Scheduler } from "./scheduler.ts";
import { ALLOW_ALL_ROBOTS, FakeHttpRouter, HONEST_UA } from "./testkit.ts";

const RIPLEY = "https://simple.ripley.com.pe";

/** A policy with zero inter-request spacing so 20-request sequences run without clock choreography. */
function makeUnpacedPolicy() {
  const clock = new FakeClock(0);
  const http = new FakeHttpRouter(clock);
  const scheduler = new Scheduler({
    clock,
    random: () => 0.5,
    documentDelayMinMs: 0,
    documentDelayMaxMs: 0,
  });
  const policy = new CrawlPolicy({
    userAgent: HONEST_UA,
    httpFetch: http.fetch,
    robotsFetch: ALLOW_ALL_ROBOTS,
    clock,
    random: () => 0.5,
    scheduler,
  });
  return { clock, http, policy };
}

describe("CrawlPolicy circuit breaker integration", () => {
  test("opens the host circuit after the 5th consecutive qualifying failure", async () => {
    const { http, policy } = makeUnpacedPolicy();
    http.setFallback({ status: 404, headers: {}, body: "not found" });

    for (let i = 0; i < 5; i++) {
      await expect(policy.fetch(`${RIPLEY}/missing/${i}`)).rejects.toThrow();
    }
    expect(policy.circuitBreaker.isOpen("simple.ripley.com.pe")).toBe(true);
  });

  test("once open, further fetches to the host fail fast without reaching the network", async () => {
    const { http, policy } = makeUnpacedPolicy();
    http.setFallback({ status: 404, headers: {}, body: "not found" });

    for (let i = 0; i < 5; i++) {
      await expect(policy.fetch(`${RIPLEY}/missing/${i}`)).rejects.toThrow();
    }
    expect(http.calls.length).toBe(5);

    await expect(policy.fetch(`${RIPLEY}/missing/next`)).rejects.toThrow(CircuitOpenError);
    expect(http.calls.length).toBe(5); // no new network call was made
  });

  test("opens when the failure rate exceeds 50% over the last 20 requests without a 5-streak", async () => {
    const { http, policy } = makeUnpacedPolicy();
    // 4 blocks of [success, fail, fail, fail, fail]: longest failure streak is 4
    // (never trips the consecutive-failure threshold), 16/20 = 80% failures, and
    // the sequence ends on a failure so the rate check evaluates once the window fills.
    const outcomes = Array.from({ length: 4 }, () => [200, 404, 404, 404, 404]).flat();
    for (const [i, status] of outcomes.entries()) {
      http.queue(`${RIPLEY}/mixed/${i}`, {
        status,
        headers: {},
        body: status === 200 ? "ok" : "not found",
      });
      if (status === 200) {
        await policy.fetch(`${RIPLEY}/mixed/${i}`);
      } else {
        await expect(policy.fetch(`${RIPLEY}/mixed/${i}`)).rejects.toThrow();
      }
    }
    expect(policy.circuitBreaker.isOpen("simple.ripley.com.pe")).toBe(true);
  });
});

describe("CrawlPolicy challenge / CAPTCHA detection", () => {
  test("a challenge body opens the circuit immediately and throws with no retry", async () => {
    const { http, policy } = makeUnpacedPolicy();
    http.queue(`${RIPLEY}/blocked`, {
      status: 200,
      headers: {},
      body: "<html><body>Please verify you are human to continue</body></html>",
    });

    await expect(policy.fetch(`${RIPLEY}/blocked`)).rejects.toThrow(ChallengeDetectedError);
    expect(http.calls.length).toBe(1); // no retry attempts
    expect(policy.circuitBreaker.isOpen("simple.ripley.com.pe")).toBe(true);
  });

  test("a CAPTCHA marker in the body trips the circuit even on an otherwise-successful status", async () => {
    const { http, policy } = makeUnpacedPolicy();
    http.queue(`${RIPLEY}/captcha`, {
      status: 200,
      headers: {},
      body: "<div class='px-captcha'>Solve the captcha to proceed</div>",
    });

    await expect(policy.fetch(`${RIPLEY}/captcha`)).rejects.toThrow(ChallengeDetectedError);
    expect(http.calls.length).toBe(1);
    expect(policy.circuitBreaker.isOpen("simple.ripley.com.pe")).toBe(true);
  });
});
