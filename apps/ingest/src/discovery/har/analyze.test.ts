import { describe, expect, test } from "bun:test";
import { ScrapError } from "@scrapito/contracts";
import { analyzeHar } from "./analyze.ts";
import { parseHar, type HarFile } from "./har-schema.ts";
import { REDACTED } from "./sanitize.ts";

interface EntrySpec {
  method?: string;
  url: string;
  mimeType?: string;
  body?: string;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
}

function harOf(...specs: EntrySpec[]): HarFile {
  return parseHar({
    log: {
      version: "1.2",
      entries: specs.map((s) => ({
        startedDateTime: "2026-07-19T00:00:00.000Z",
        request: {
          method: s.method ?? "GET",
          url: s.url,
          headers: s.requestHeaders ?? [],
          queryString: [],
        },
        response: {
          status: 200,
          headers: s.responseHeaders ?? [],
          content: {
            mimeType: s.mimeType ?? "application/json",
            ...(s.body !== undefined ? { text: s.body } : {}),
          },
        },
      })),
    },
  });
}

const PRODUCT_BODY = JSON.stringify({
  products: [{ sku: "TV-1", price: 1299.99, brand: "Acme" }],
});

describe("analyzeHar — grouping and path templates", () => {
  test("numeric path segments collapse into one {n} group across detail URLs", () => {
    const result = analyzeHar(
      harOf(
        { url: "https://www.promart.pe/api/products/123?page=1", body: PRODUCT_BODY },
        { url: "https://www.promart.pe/api/products/456?page=2", body: PRODUCT_BODY },
      ),
    );

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.pathTemplate).toBe("/api/products/{n}");
    expect(candidate.method).toBe("GET");
    expect(candidate.origin).toBe("https://www.promart.pe");
    expect(candidate.requestCount).toBe(2);
  });

  test("same path with a different method is a separate candidate", () => {
    const result = analyzeHar(
      harOf(
        { url: "https://www.promart.pe/api/cart", body: "{}" },
        { method: "POST", url: "https://www.promart.pe/api/cart", body: "{}" },
      ),
    );

    expect(result.candidates.map((c) => c.method).sort()).toEqual(["GET", "POST"]);
    expect(result.stats.groups).toBe(2);
  });
});

describe("analyzeHar — parameter diffing and pagination inference", () => {
  test("numeric `page` param with distinct values → page pagination; repeated value is constant", () => {
    const result = analyzeHar(
      harOf(
        { url: "https://www.promart.pe/api/search?q=tv&page=1", body: PRODUCT_BODY },
        { url: "https://www.promart.pe/api/search?q=tv&page=2", body: PRODUCT_BODY },
      ),
    );

    const candidate = result.candidates[0]!;
    expect(candidate.constantParams).toEqual({ q: "tv" });
    expect(candidate.varyingParams).toEqual({ page: ["1", "2"] });
    expect(candidate.pagination).toEqual({ kind: "page", parameters: ["page"] });
  });

  test("_from/_to pairs → offset-range pagination", () => {
    const result = analyzeHar(
      harOf(
        { url: "https://simple.ripley.com.pe/api/list?_from=0&_to=24", body: "{}" },
        { url: "https://simple.ripley.com.pe/api/list?_from=24&_to=48", body: "{}" },
      ),
    );

    expect(result.candidates[0]!.pagination).toEqual({
      kind: "offset-range",
      parameters: ["_from", "_to"],
    });
  });

  test("opaque cursor param → cursor pagination", () => {
    const result = analyzeHar(
      harOf(
        { url: "https://www.falabella.com.pe/api/feed?cursor=abc", body: "{}" },
        { url: "https://www.falabella.com.pe/api/feed?cursor=def", body: "{}" },
      ),
    );

    expect(result.candidates[0]!.pagination).toEqual({ kind: "cursor", parameters: ["cursor"] });
  });

  test("a single observation cannot ground a pagination hypothesis", () => {
    const result = analyzeHar(
      harOf({ url: "https://www.promart.pe/api/search?page=1", body: PRODUCT_BODY }),
    );

    expect(result.candidates[0]!.pagination).toBeNull();
    expect(result.candidates[0]!.constantParams).toEqual({ page: "1" });
  });
});

describe("analyzeHar — classification", () => {
  test("asset and HTML document entries are excluded from candidates but counted", () => {
    const result = analyzeHar(
      harOf(
        { url: "https://www.promart.pe/", mimeType: "text/html", body: "<html></html>" },
        { url: "https://promart.vteximg.com.br/i.png", mimeType: "image/png" },
        { url: "https://www.promart.pe/app.js", mimeType: "text/javascript" },
        { url: "https://www.promart.pe/api/search?q=tv", body: PRODUCT_BODY },
      ),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pathTemplate).toBe("/api/search");
    expect(result.stats).toEqual({
      entries: 4,
      jsonEntries: 1,
      documentEntries: 1,
      assetEntries: 2,
      groups: 1,
    });
  });

  test("product-like response keys are detected from the sample body", () => {
    const result = analyzeHar(
      harOf({ url: "https://www.promart.pe/api/search?q=tv", body: PRODUCT_BODY }),
    );

    expect(result.candidates[0]!.productLikeKeys).toEqual(["brand", "price", "products", "sku"]);
  });

  test("non-catalog JSON yields no product-like keys", () => {
    const result = analyzeHar(
      harOf({ url: "https://www.promart.pe/api/session-ping", body: '{"ok":true}' }),
    );

    expect(result.candidates[0]!.productLikeKeys).toEqual([]);
  });
});

describe("analyzeHar — ranking, samples, determinism", () => {
  test("candidates are sorted by confidence descending", () => {
    const result = analyzeHar(
      harOf(
        // Bare single-hit endpoint: lowest confidence.
        { url: "https://www.promart.pe/api/status", body: '{"ok":true}' },
        // Product-like, paginated, repeated GET: highest confidence.
        { url: "https://www.promart.pe/api/search?page=1", body: PRODUCT_BODY },
        { url: "https://www.promart.pe/api/search?page=2", body: PRODUCT_BODY },
      ),
    );

    expect(result.candidates.map((c) => c.pathTemplate)).toEqual(["/api/search", "/api/status"]);
    expect(result.candidates[0]!.confidence).toBeGreaterThan(result.candidates[1]!.confidence);
  });

  test("samples are emitted in deterministic first-seen order and named sequentially", () => {
    const har = harOf(
      { url: "https://www.promart.pe/api/a?page=1", body: '{"a":1}' },
      { url: "https://www.promart.pe/api/b?page=1", body: '{"b":2}' },
    );

    const first = analyzeHar(har);
    expect(first.samples.map((s) => s.name)).toEqual([
      "samples/000.response.json",
      "samples/001.response.json",
    ]);
    expect(first.samples.map((s) => s.body)).toEqual(['{"a":1}', '{"b":2}']);
    const byTemplate = new Map(first.candidates.map((c) => [c.pathTemplate, c.sampleArtifact]));
    expect(byTemplate.get("/api/a")).toBe("samples/000.response.json");
    expect(byTemplate.get("/api/b")).toBe("samples/001.response.json");

    // Re-running on the same HAR is byte-identical (verify's reproducibility
    // check depends on this).
    expect(analyzeHar(har)).toEqual(first);
  });
});

describe("analyzeHar — fail-closed on unsanitized evidence", () => {
  test("a live sensitive request header aborts analysis with HAR_NOT_SANITIZED", () => {
    const har = harOf({
      url: "https://www.promart.pe/api/search?q=tv",
      requestHeaders: [{ name: "cookie", value: "sessionid=live" }],
      body: "{}",
    });

    let thrown: unknown;
    try {
      analyzeHar(har);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ScrapError);
    expect((thrown as ScrapError).code).toBe("HAR_NOT_SANITIZED");
  });

  test("a live sensitive response header also aborts analysis", () => {
    const har = harOf({
      url: "https://www.promart.pe/api/search?q=tv",
      responseHeaders: [{ name: "set-cookie", value: "sid=live" }],
      body: "{}",
    });

    expect(() => analyzeHar(har)).toThrow(/discover sanitize/);
  });

  test("already-redacted sensitive headers do not abort analysis", () => {
    const har = harOf({
      url: "https://www.promart.pe/api/search?q=tv",
      requestHeaders: [{ name: "cookie", value: REDACTED }],
      responseHeaders: [{ name: "set-cookie", value: REDACTED }],
      body: "{}",
    });

    expect(analyzeHar(har).candidates).toHaveLength(1);
  });
});
