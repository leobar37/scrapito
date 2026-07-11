import { describe, expect, test } from "bun:test";
import { FakeClock } from "./clock.ts";
import { Scheduler } from "./scheduler.ts";

describe("Scheduler", () => {
  test("rejects a global concurrency limit above 4", () => {
    const clock = new FakeClock(0);
    expect(() => new Scheduler({ clock, globalLimit: 5 })).toThrow();
  });

  test("acquire resolves immediately when a global slot and host slot are free", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ clock, random: () => 0.5 });
    const release = await scheduler.acquire("host-a", "document");
    expect(typeof release).toBe("function");
    release();
  });

  test("release() schedules the host's next-available time using the deterministic document delay", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ clock, random: () => 0.5 });
    const release = await scheduler.acquire("host-a", "document");
    release();
    // random()=0.5 -> midpoint of the [1500,3000] document window = 2250
    expect(scheduler.nextAvailableAt("host-a")).toBe(2250);
  });

  test("release() uses the tighter image delay window", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ clock, random: () => 0.5 });
    const release = await scheduler.acquire("cdn-a", "image");
    release();
    // midpoint of the [250,750] image window = 500
    expect(scheduler.nextAvailableAt("cdn-a")).toBe(500);
  });

  test("a second acquire for the same host waits out the per-host spacing delay", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ clock, random: () => 0.5 });
    const release1 = await scheduler.acquire("host-a", "document");
    release1();
    expect(scheduler.nextAvailableAt("host-a")).toBe(2250);

    let resolved = false;
    const p = scheduler.acquire("host-a", "document").then((release2) => {
      resolved = true;
      release2();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    await clock.advance(2250);
    await p;
    expect(resolved).toBe(true);
  });

  test("only one in-flight acquire per host; a second waits until the first releases", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({
      clock,
      random: () => 0.5,
      documentDelayMinMs: 0,
      documentDelayMaxMs: 0,
    });
    const release1 = await scheduler.acquire("host-a", "document");

    let resolved = false;
    const p = scheduler.acquire("host-a", "document").then((release2) => {
      resolved = true;
      release2();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    release1();
    await p;
    expect(resolved).toBe(true);
  });

  test("global limit serializes acquisitions across different hosts", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({
      clock,
      random: () => 0.5,
      globalLimit: 1,
      documentDelayMinMs: 0,
      documentDelayMaxMs: 0,
    });
    const release1 = await scheduler.acquire("host-a", "document");

    let resolved = false;
    const p = scheduler.acquire("host-b", "document").then((release2) => {
      resolved = true;
      release2();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    release1();
    await p;
    expect(resolved).toBe(true);
  });

  test("prefers a waiting document request over an image request for a freed slot", async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({
      clock,
      random: () => 0.5,
      globalLimit: 1,
      documentDelayMinMs: 0,
      documentDelayMaxMs: 0,
      imageDelayMinMs: 0,
      imageDelayMaxMs: 0,
    });
    const release0 = await scheduler.acquire("seed-host", "document");

    const order: string[] = [];
    const imgP = scheduler.acquire("cdn-a", "image").then((release) => {
      order.push("image");
      return release;
    });
    const docP = scheduler.acquire("host-b", "document").then((release) => {
      order.push("document");
      return release;
    });
    await Promise.resolve();

    release0();
    const releaseDoc = await docP;
    expect(order).toEqual(["document"]);

    releaseDoc();
    const releaseImg = await imgP;
    expect(order).toEqual(["document", "image"]);
    releaseImg();
  });

  test("penalize only raises the host's next-available time, never lowers it", () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ clock, random: () => 0.5 });
    scheduler.penalize("host-a", 5000);
    expect(scheduler.nextAvailableAt("host-a")).toBe(5000);
    scheduler.penalize("host-a", 1000);
    expect(scheduler.nextAvailableAt("host-a")).toBe(5000);
    scheduler.penalize("host-a", 9000);
    expect(scheduler.nextAvailableAt("host-a")).toBe(9000);
  });

  test("nextAvailableAt defaults to 0 for a host that has never been used", () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ clock, random: () => 0.5 });
    expect(scheduler.nextAvailableAt("never-seen.example")).toBe(0);
  });
});
