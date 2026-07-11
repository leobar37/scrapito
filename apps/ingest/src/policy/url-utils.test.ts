import { describe, expect, test } from "bun:test";
import { canonicalizeUrl } from "./url-utils.ts";

describe("canonicalizeUrl", () => {
  test("lowercases the host", () => {
    expect(canonicalizeUrl("https://Simple.Ripley.COM.pe/product/1")).toBe(
      "https://simple.ripley.com.pe/product/1",
    );
  });

  test("drops the fragment", () => {
    expect(canonicalizeUrl("https://simple.ripley.com.pe/product/1#reviews")).toBe(
      "https://simple.ripley.com.pe/product/1",
    );
  });

  test("strips known tracking params but keeps real query params", () => {
    const out = canonicalizeUrl(
      "https://www.falabella.com.pe/falabella-pe/product/1?utm_source=fb&utm_campaign=x&color=red&gclid=abc&fbclid=xyz&size=M",
    );
    expect(out).toBe("https://www.falabella.com.pe/falabella-pe/product/1?color=red&size=M");
  });

  test("sorts remaining params for stable equality across param order", () => {
    const a = canonicalizeUrl("https://www.falabella.com.pe/falabella-pe/product/1?b=2&a=1");
    const b = canonicalizeUrl("https://www.falabella.com.pe/falabella-pe/product/1?a=1&b=2");
    expect(a).toBe(b);
    expect(a).toBe("https://www.falabella.com.pe/falabella-pe/product/1?a=1&b=2");
  });

  test("two URLs that differ only by tracking params and order canonicalize identically", () => {
    const a = canonicalizeUrl(
      "https://simple.ripley.com.pe/p/x?utm_medium=cpc&sku=42&ref=home",
    );
    const b = canonicalizeUrl("https://simple.ripley.com.pe/p/x?sku=42");
    expect(a).toBe(b);
  });
});
