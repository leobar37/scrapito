import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ProductInputSchema } from "../domain/schemas.ts";
import {
  normalizeFalabellaDetail,
  normalizeFalabellaList,
} from "./falabella-pe/normalize.ts";
import { canonicalizeFalabellaImage, canonicalizeRipleyImage } from "./image-url.ts";
import { toCents } from "./money.ts";
import { normalizeRipleyDetail, normalizeRipleyList } from "./ripley-pe/normalize.ts";

const ripleyListHtml = readFileSync(
  join(import.meta.dir, "ripley-pe", "__fixtures__", "list.html"),
  "utf8",
);
const ripleyDetailHtml = readFileSync(
  join(import.meta.dir, "ripley-pe", "__fixtures__", "detail.html"),
  "utf8",
);
const falabellaListHtml = readFileSync(
  join(import.meta.dir, "falabella-pe", "__fixtures__", "list.html"),
  "utf8",
);

function expectValidProduct(product: unknown): void {
  const parsed = ProductInputSchema.safeParse(product);
  if (!parsed.success) {
    throw new Error(`product failed ProductInputSchema: ${parsed.error.message}`);
  }
}

describe("normalizeRipleyList", () => {
  test("normalizes the fixture list, rejecting the SKU-less entry and keeping the rest", () => {
    const { products, rejected, ok } = normalizeRipleyList(ripleyListHtml);
    expect(ok).toBe(true);
    expect(rejected).toBe(1);
    expect(products).toHaveLength(2);
    for (const p of products) expectValidProduct(p);
  });

  test("normalizes sponsored and organic results to the identical product schema", () => {
    const { products } = normalizeRipleyList(ripleyListHtml);
    const organic = products.find((p) => p.externalId === "2000389084910");
    const sponsored = products.find((p) => p.externalId === "2000111222333");
    expect(organic?.sponsored).toBe(false);
    expect(sponsored?.sponsored).toBe(true);
    // Same shape regardless of sponsorship: identical top-level key sets.
    expect(Object.keys(organic ?? {}).sort()).toEqual(Object.keys(sponsored ?? {}).sort());
    expect(sponsored?.sellerId).toBe("S99");
    expect(sponsored?.sellerName).toBe("MarketPlace SAC");
  });

  test("computes céntimos and canonical URLs from the fixture's first product", () => {
    const { products } = normalizeRipleyList(ripleyListHtml);
    const laptop = products.find((p) => p.externalId === "2000389084910");
    expect(laptop?.canonicalUrl).toBe(
      "https://simple.ripley.com.pe/laptop-hp-15-2000389084910p",
    );
    expect(laptop?.price.regularCents).toBe(299990);
    expect(laptop?.price.offerCents).toBe(249990);
    expect(laptop?.price.cardCents).toBe(229990);
    // Trailing-dot legacy image URL gets `webp` appended.
    expect(laptop?.images).toEqual([
      {
        url: "https://rimage.ripley.com.pe/home.ripley/Attachment/WOP/1/2000389084910/full_image-2000389084910.webp",
        position: 0,
      },
    ]);
  });

  test("returns ok:false and no products when __NEXT_DATA__ is missing", () => {
    const html = "<!doctype html><html><body>no next data here</body></html>";
    expect(normalizeRipleyList(html)).toEqual({ products: [], rejected: 0, ok: false });
  });

  test("returns ok:false when the __NEXT_DATA__ script contains malformed JSON", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"props": this is not json</script>';
    expect(normalizeRipleyList(html)).toEqual({ products: [], rejected: 0, ok: false });
  });

  test("returns ok:true with no products/rejects when the products array is empty", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"findabilityProps":{"data":{"products":[]}}}}}' +
      "</script>";
    expect(normalizeRipleyList(html)).toEqual({ products: [], rejected: 0, ok: true });
  });

  test("returns ok:false when the upstream shape moves products to a different path", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"products":[{"partNumber":"1","name":"X","url":"/x","prices":{"listPrice":10}}]}}}' +
      "</script>";
    const result = normalizeRipleyList(html);
    expect(result.ok).toBe(false);
    expect(result.products).toEqual([]);
  });

  test("rejects an item with sku/name/url but no usable price, page still ok", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"findabilityProps":{"data":{"products":[' +
      '{"partNumber":"999","name":"Sin precio","url":"/sin-precio-999p","prices":{}},' +
      '{"partNumber":"1000","name":"Con precio","url":"/con-precio-1000p","prices":{"listPrice":19.9}}' +
      "]}}}}}" +
      "</script>";
    const { products, rejected, ok } = normalizeRipleyList(html);
    expect(ok).toBe(true);
    expect(rejected).toBe(1);
    expect(products).toHaveLength(1);
    expect(products[0]?.externalId).toBe("1000");
  });
});

describe("normalizeRipleyDetail", () => {
  test("normalizes the fixture detail page from JSON-LD, canonicalizing both images", () => {
    const product = normalizeRipleyDetail(
      ripleyDetailHtml,
      "https://simple.ripley.com.pe/laptop-hp-15-2000389084910p",
    );
    expect(product).not.toBeNull();
    if (!product) throw new Error("expected product");
    expectValidProduct(product);
    expect(product.externalId).toBe("2000389084910");
    expect(product.name).toBe("Laptop HP 15-fd0026la");
    expect(product.brand).toBe("HP");
    expect(product.sellerName).toBe("Ripley");
    expect(product.price.offerCents).toBe(249990);
    expect(product.price.inStock).toBe(true);
    // Complete `.jpeg` JSON-LD URL is unchanged; trailing-dot legacy URL gets `webp`.
    expect(product.images).toEqual([
      {
        url: "https://rimage.ripley.com.pe/home.ripley/Attachment/WOP/1/2000389084910/full_image-2000389084910.jpeg",
        position: 0,
      },
      {
        url: "https://rimage.ripley.com.pe/home.ripley/Attachment/WOP/1/2000389084910/alt-2000389084910.webp",
        position: 1,
      },
    ]);
  });

  test("normalizes successfully with no variant/additionalProperty data in JSON-LD", () => {
    // The base JSON-LD contract (name/sku/offers) requires no variant fields;
    // absence of `hasVariant`/`additionalProperty` must not block normalization.
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Mouse Inalambrico","sku":"MS-100",
       "offers":{"@type":"Offer","price":"49.90","priceCurrency":"PEN","availability":"https://schema.org/InStock"}}
    </script>`;
    const product = normalizeRipleyDetail(html, "https://simple.ripley.com.pe/mouse-ms-100p");
    expect(product).not.toBeNull();
    if (!product) throw new Error("expected product");
    expectValidProduct(product);
    expect(product.price.offerCents).toBe(4990);
  });

  test("returns null for a non-PEN currency offer", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Imported Gadget","sku":"IMP-1",
       "offers":{"@type":"Offer","price":"10.00","priceCurrency":"USD"}}
    </script>`;
    expect(normalizeRipleyDetail(html, "https://simple.ripley.com.pe/imported-gadget-imp-1p")).toBeNull();
  });

  test("picks the Product node out of multiple JSON-LD blocks (breadcrumb + product)", () => {
    const html = `
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"Teclado Mecanico","sku":"KB-7",
         "offers":{"@type":"Offer","price":"120.00","priceCurrency":"PEN"}}
      </script>
    `;
    const product = normalizeRipleyDetail(html, "https://simple.ripley.com.pe/teclado-kb-7p");
    expect(product?.name).toBe("Teclado Mecanico");
    expect(product?.externalId).toBe("KB-7");
  });

  test("returns null when no Product JSON-LD block is present", () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>';
    expect(normalizeRipleyDetail(html, "https://simple.ripley.com.pe/whatever-1p")).toBeNull();
  });
});

describe("normalizeFalabellaList", () => {
  test("normalizes the fixture list, rejecting the SKU-less entry and keeping the rest", () => {
    const { products, rejected, ok } = normalizeFalabellaList(falabellaListHtml);
    expect(ok).toBe(true);
    expect(rejected).toBe(1);
    expect(products).toHaveLength(2);
    for (const p of products) expectValidProduct(p);
  });

  test("normalizes sponsored and organic results to the identical product schema", () => {
    const { products } = normalizeFalabellaList(falabellaListHtml);
    const organic = products.find((p) => p.externalId === "20936199");
    const sponsored = products.find((p) => p.externalId === "18500001");
    expect(organic?.sponsored).toBe(false);
    expect(sponsored?.sponsored).toBe(true);
    expect(Object.keys(organic ?? {}).sort()).toEqual(Object.keys(sponsored ?? {}).sort());
    expect(sponsored?.sellerId).toBe("MP1");
    expect(sponsored?.sellerName).toBe("TiendaTech");
  });

  test("parses Peru-format price strings and canonicalizes/drops fixture images", () => {
    const { products } = normalizeFalabellaList(falabellaListHtml);
    const fridge = products.find((p) => p.externalId === "20936199");
    expect(fridge?.canonicalUrl).toBe(
      "https://www.falabella.com.pe/falabella-pe/product/20936199/Refrigeradora/20936199",
    );
    expect(fridge?.price.regularCents).toBe(199900);
    expect(fridge?.price.offerCents).toBe(149900);
    expect(fridge?.price.cardCents).toBe(139900);
    // `w=1500,h=1500,fit=pad` collapses to `/public`; the images.falabella.com
    // marketing asset is dropped entirely (not a broken/empty slot).
    expect(fridge?.images).toEqual([
      { url: "https://media.falabella.com.pe/falabellaPE/20936199_20/public", position: 0 },
    ]);

    const tv = products.find((p) => p.externalId === "18500001");
    // Already-canonical `/public` URL is unchanged.
    expect(tv?.images).toEqual([
      { url: "https://media.falabella.com.pe/falabellaPE/18500001_01/public", position: 0 },
    ]);
  });

  test("returns ok:false and no products when __NEXT_DATA__ is missing", () => {
    const html = "<!doctype html><html><body>nothing to see</body></html>";
    expect(normalizeFalabellaList(html)).toEqual({ products: [], rejected: 0, ok: false });
  });

  test("returns ok:false when the __NEXT_DATA__ script contains malformed JSON", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"props": {broken</script>';
    expect(normalizeFalabellaList(html)).toEqual({ products: [], rejected: 0, ok: false });
  });

  test("returns ok:true with no products/rejects when results is empty", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"results":[]}}}</script>';
    expect(normalizeFalabellaList(html)).toEqual({ products: [], rejected: 0, ok: true });
  });

  test("returns ok:false when the upstream shape moves results to a different path", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"data":{"results":[{"skuId":"1","displayName":"X","url":"/x","prices":[{"type":"normalPrice","price":["10.00"]}]}]}}}}' +
      "</script>";
    const result = normalizeFalabellaList(html);
    expect(result.ok).toBe(false);
    expect(result.products).toEqual([]);
  });

  test("rejects an item with sku/name/url but no usable price, page still ok", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"results":[' +
      '{"skuId":"777","displayName":"Sin precio","url":"/sin-precio-777","prices":[]},' +
      '{"skuId":"778","displayName":"Con precio","url":"/con-precio-778","prices":[{"type":"normalPrice","price":["25.00"]}]}' +
      "]}}}" +
      "</script>";
    const { products, rejected, ok } = normalizeFalabellaList(html);
    expect(ok).toBe(true);
    expect(rejected).toBe(1);
    expect(products).toHaveLength(1);
    expect(products[0]?.externalId).toBe("778");
  });
});

describe("normalizeFalabellaDetail", () => {
  test("normalizes from props.pageProps.product when present", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"product":{"skuId":"555","displayName":"Licuadora",' +
      '"url":"/falabella-pe/product/555/licuadora","prices":[{"type":"normalPrice","price":["150.00"]}]}}}}' +
      "</script>";
    const product = normalizeFalabellaDetail(
      html,
      "https://www.falabella.com.pe/falabella-pe/product/555/licuadora",
    );
    expect(product).not.toBeNull();
    if (!product) throw new Error("expected product");
    expectValidProduct(product);
    expect(product.externalId).toBe("555");
    expect(product.price.regularCents).toBe(15000);
  });

  test("falls back to props.pageProps.results[0] when there is no dedicated product field", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"results":[{"skuId":"556","displayName":"Batidora",' +
      '"url":"/falabella-pe/product/556/batidora","prices":[{"type":"normalPrice","price":["90.00"]}]}]}}}' +
      "</script>";
    const product = normalizeFalabellaDetail(
      html,
      "https://www.falabella.com.pe/falabella-pe/product/556/batidora",
    );
    expect(product?.externalId).toBe("556");
    expectValidProduct(product);
  });

  test("falls back to JSON-LD Product when no SSR product/results data exists", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Aspiradora Robot","sku":"AR-9",
       "offers":{"@type":"Offer","price":"899.00","priceCurrency":"PEN"}}
    </script>`;
    const product = normalizeFalabellaDetail(
      html,
      "https://www.falabella.com.pe/falabella-pe/product/aspiradora-ar-9",
    );
    expect(product).not.toBeNull();
    if (!product) throw new Error("expected product");
    expectValidProduct(product);
    expect(product.externalId).toBe("AR-9");
    expect(product.price.offerCents).toBe(89900);
  });

  test("returns null when neither SSR data nor JSON-LD provide a usable price", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"product":{"skuId":"557","displayName":"Sin precio","url":"/x","prices":[]}}}}' +
      "</script>";
    expect(
      normalizeFalabellaDetail(html, "https://www.falabella.com.pe/falabella-pe/product/x"),
    ).toBeNull();
  });
});

describe("toCents", () => {
  test("converts number soles to integer céntimos", () => {
    expect(toCents(29.9)).toBe(2990);
    expect(toCents(0)).toBe(0);
    expect(toCents(1500)).toBe(150000);
  });

  test("parses Peru-formatted price strings with thousands comma and decimal dot", () => {
    expect(toCents("1,299.00")).toBe(129900);
    expect(toCents("S/ 49.90")).toBe(4990);
    expect(toCents("2,999.9")).toBe(299990);
  });

  test("returns null for missing or unparseable values", () => {
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
    expect(toCents("")).toBeNull();
    expect(toCents("gratis")).toBeNull();
    expect(toCents(Number.NaN)).toBeNull();
  });
});

describe("canonicalizeFalabellaImage", () => {
  test("collapses a sized transform segment to /public", () => {
    expect(
      canonicalizeFalabellaImage(
        "https://media.falabella.com.pe/falabellaPE/20936199_20/w=1500,h=1500,fit=pad",
      ),
    ).toBe("https://media.falabella.com.pe/falabellaPE/20936199_20/public");
  });

  test("leaves an already-canonical /public URL unchanged", () => {
    const url = "https://media.falabella.com.pe/falabellaPE/18500001_01/public";
    expect(canonicalizeFalabellaImage(url)).toBe(url);
  });

  test("drops images.falabella.com marketing/CMS assets", () => {
    expect(canonicalizeFalabellaImage("https://images.falabella.com/marketing/banner.jpg")).toBeNull();
  });

  test("rejects hosts outside the Falabella media allowlist", () => {
    expect(canonicalizeFalabellaImage("https://cdn.example.com/img.jpg")).toBeNull();
  });
});

describe("canonicalizeRipleyImage", () => {
  test("appends webp to a trailing-dot legacy listing URL", () => {
    expect(
      canonicalizeRipleyImage(
        "https://rimage.ripley.com.pe/home.ripley/Attachment/WOP/1/2065365420359/full_image-2065365420359.",
      ),
    ).toBe(
      "https://rimage.ripley.com.pe/home.ripley/Attachment/WOP/1/2065365420359/full_image-2065365420359.webp",
    );
  });

  test("leaves a complete .jpeg JSON-LD URL unchanged", () => {
    const url = "https://rimage.ripley.com.pe/home.ripley/Attachment/WOP/1/1/full_image-1.jpeg";
    expect(canonicalizeRipleyImage(url)).toBe(url);
  });

  test("rejects hosts other than rimage.ripley.com.pe", () => {
    expect(canonicalizeRipleyImage("https://simple.ripley.com.pe/some/image.jpg")).toBeNull();
  });
});
