import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { FakeClock } from "./clock.ts";

const HOST = "simple.ripley.com.pe";

describe("CircuitBreaker", () => {
  test("stays closed under 5 consecutive failures", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 4; i++) cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(false);
  });

  test("opens after the 5th consecutive qualifying failure", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(true);
  });

  test("a success resets the consecutive-failure streak", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 4; i++) cb.recordFailure(HOST);
    cb.recordSuccess(HOST);
    for (let i = 0; i < 4; i++) cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(false);
  });

  test("opens when failure rate exceeds 50% over the last 20 requests, absent a 5-streak", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    // 4 blocks of [success, fail, fail, fail, fail] = 16 failures / 20 = 80%,
    // longest failure streak is 4 (never trips the consecutive threshold),
    // and the sequence ends on a failure so the rate check evaluates at n=20.
    for (let block = 0; block < 4; block++) {
      cb.recordSuccess(HOST);
      cb.recordFailure(HOST);
      cb.recordFailure(HOST);
      cb.recordFailure(HOST);
      cb.recordFailure(HOST);
    }
    expect(cb.isOpen(HOST)).toBe(true);
  });

  test("stays closed at exactly 50% failure rate over 20 requests", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let block = 0; block < 5; block++) {
      cb.recordFailure(HOST);
      cb.recordFailure(HOST);
      cb.recordSuccess(HOST);
      cb.recordSuccess(HOST);
    }
    expect(cb.isOpen(HOST)).toBe(false);
  });

  test("tripImmediately opens the circuit regardless of history", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    cb.recordSuccess(HOST);
    cb.tripImmediately(HOST);
    expect(cb.isOpen(HOST)).toBe(true);
  });

  test("cools down after cooldownMs and half-closes (single failure does not re-trip)", async () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(true);
    await clock.advance(15 * 60 * 1000); // base cooldown
    expect(cb.isOpen(HOST)).toBe(false);
    cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(false);
  });

  test("repeated trips double the cooldown up to the 2-hour cap", async () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(true);

    // Half-close after the first (15 min) cooldown, then re-trip immediately.
    await clock.advance(15 * 60 * 1000);
    expect(cb.isOpen(HOST)).toBe(false);
    for (let i = 0; i < 5; i++) cb.recordFailure(HOST);
    expect(cb.isOpen(HOST)).toBe(true);

    // Second cooldown must be doubled (30 min): not yet closed at +15min.
    await clock.advance(15 * 60 * 1000);
    expect(cb.isOpen(HOST)).toBe(true);
    await clock.advance(15 * 60 * 1000);
    expect(cb.isOpen(HOST)).toBe(false);
  });

  test("circuits are tracked independently per host", () => {
    const clock = new FakeClock(0);
    const cb = new CircuitBreaker(clock);
    for (let i = 0; i < 5; i++) cb.recordFailure("host-a.example");
    expect(cb.isOpen("host-a.example")).toBe(true);
    expect(cb.isOpen("host-b.example")).toBe(false);
  });
});
