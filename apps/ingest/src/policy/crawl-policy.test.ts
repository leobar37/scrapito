import { describe, expect, test } from "bun:test";
import { PolicyError } from "@scrapito/contracts";
import { CrawlPolicy } from "./crawl-policy.ts";
import { FakeClock } from "./clock.ts";
import { ALLOW_ALL_ROBOTS, BROWSER_UA, FakeHttpRouter, HONEST_UA } from "./testkit.ts";

function makePolicy(overrides: Partial<ConstructorParameters<typeof CrawlPolicy>[0]> = {}) {
  const clock = new FakeClock(0);
  const http = new FakeHttpRouter(clock);
  const policy = new CrawlPolicy({
    userAgent: HONEST_UA,
    httpFetch: http.fetch,
    robotsFetch: ALLOW_ALL_ROBOTS,
    clock,
    random: () => 0.5,
    ...overrides,
  });
  return { clock, http, policy };
}

describe("CrawlPolicy user-agent validation", () => {
  test("rejects a browser-impersonating user agent at construction", () => {
    const clock = new FakeClock(0);
    const http = new FakeHttpRouter(clock);
    expect(
      () =>
        new CrawlPolicy({
          userAgent: BROWSER_UA,
          httpFetch: http.fetch,
          robotsFetch: ALLOW_ALL_ROBOTS,
          clock,
        }),
    ).toThrow(PolicyError);
  });

  test("rejects an empty user agent", () => {
    const clock = new FakeClock(0);
    const http = new FakeHttpRouter(clock);
    expect(
      () =>
        new CrawlPolicy({
          userAgent: "  ",
          httpFetch: http.fetch,
          clock,
        }),
    ).toThrow(PolicyError);
  });

  test("accepts an honest bot identity (name + contact URL)", () => {
    expect(() => makePolicy()).not.toThrow();
  });

  test("accepts a UA that self-identifies as a bot without a contact URL", () => {
    const clock = new FakeClock(0);
    const http = new FakeHttpRouter(clock);
    expect(
      () =>
        new CrawlPolicy({
          userAgent: "ScrapManyBot/1.0",
          httpFetch: http.fetch,
          clock,
        }),
    ).not.toThrow();
  });

  test("rejects a user agent explicitly disallowed by a store's robots file", () => {
    const clock = new FakeClock(0);
    const http = new FakeHttpRouter(clock);
    expect(
      () =>
        new CrawlPolicy({
          userAgent: HONEST_UA,
          httpFetch: http.fetch,
          clock,
          disallowedUserAgents: [/ScrapMany/],
        }),
    ).toThrow(PolicyError);
  });
});

describe("CrawlPolicy.assertNavigable (synchronous structural checks)", () => {
  test("rejects non-HTTPS URLs", () => {
    const { policy } = makePolicy();
    expect(() => policy.assertNavigable("http://simple.ripley.com.pe/product/1")).toThrow(
      PolicyError,
    );
  });

  test("rejects the forbidden legacy Ripley domain", () => {
    const { policy } = makePolicy();
    expect(() => policy.assertNavigable("https://www.ripley.com.pe/product/1")).toThrow(
      PolicyError,
    );
  });

  test("rejects hosts not on the allowlist", () => {
    const { policy } = makePolicy();
    expect(() => policy.assertNavigable("https://evil.example.com/steal")).toThrow(PolicyError);
  });

  test.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["192.168.1.1"],
    ["169.254.1.1"],
    ["localhost"],
  ])("rejects private/local target %s", (host) => {
    const { policy } = makePolicy();
    expect(() => policy.assertNavigable(`https://${host}/`)).toThrow(PolicyError);
  });

  test.each([
    ["simple.ripley.com.pe", "/escribe-tu-review/123"],
    ["simple.ripley.com.pe", "/api/v2/recommendations/product/1"],
    ["simple.ripley.com.pe", "/marketingcomponent/api/banner"],
    ["www.falabella.com.pe", "/cgi-bin/x"],
    ["www.falabella.com.pe", "/falabella-pe/basket"],
    ["www.falabella.com.pe", "/falabella-pe/checkout/step1"],
    ["www.falabella.com.pe", "/falabella-pe/orders/123"],
  ])("rejects the safety-floor path %s%s", (host, path) => {
    const { policy } = makePolicy();
    expect(() => policy.assertNavigable(`https://${host}${path}`)).toThrow(PolicyError);
  });

  test("accepts an allowlisted host on a non-excluded path", () => {
    const { policy } = makePolicy();
    expect(() => policy.assertNavigable("https://simple.ripley.com.pe/product/1")).not.toThrow();
  });
});
