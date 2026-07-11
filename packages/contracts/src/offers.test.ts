import { describe, expect, test } from "bun:test";
import { deriveOffer } from "./offers.ts";

describe("deriveOffer", () => {
  test("public discount: 10000 -> 7500 gives 2500/2500bps/public", () => {
    const r = deriveOffer({ regularCents: 10000, offerCents: 7500, cardCents: null });
    expect(r).toEqual({
      effectiveCents: 7500,
      priceAccess: "public",
      quality: "verified_discount",
      discountCents: 2500,
      discountBps: 2500,
    });
  });

  test("card cheaper than offer: 10000/8000/7000 chooses 7000/card", () => {
    const r = deriveOffer({ regularCents: 10000, offerCents: 8000, cardCents: 7000 });
    expect(r).toEqual({
      effectiveCents: 7000,
      priceAccess: "card",
      quality: "verified_discount",
      discountCents: 3000,
      discountBps: 3000,
    });
  });

  test("promo without comparable regular price is promotional with null discount", () => {
    const r = deriveOffer({ regularCents: null, offerCents: 8000, cardCents: null });
    expect(r).toEqual({
      effectiveCents: 8000,
      priceAccess: "public",
      quality: "promotional_price",
      discountCents: null,
      discountBps: null,
    });
  });

  test("equal promo/regular is promotional with null discount", () => {
    const r = deriveOffer({ regularCents: 10000, offerCents: 10000, cardCents: null });
    expect(r).toEqual({
      effectiveCents: 10000,
      priceAccess: "public",
      quality: "promotional_price",
      discountCents: null,
      discountBps: null,
    });
  });

  test("no promotional fields present is not an offer", () => {
    expect(deriveOffer({ regularCents: 10000, offerCents: null, cardCents: null })).toBeNull();
  });

  test("ties between card and public prefer public", () => {
    const r = deriveOffer({ regularCents: 10000, offerCents: 7000, cardCents: 7000 });
    expect(r?.priceAccess).toBe("public");
    expect(r?.effectiveCents).toBe(7000);
  });

  test("card-only candidate (no regular, no offer) is card access", () => {
    const r = deriveOffer({ regularCents: null, offerCents: null, cardCents: 5000 });
    expect(r).toEqual({
      effectiveCents: 5000,
      priceAccess: "card",
      quality: "promotional_price",
      discountCents: null,
      discountBps: null,
    });
  });
});
