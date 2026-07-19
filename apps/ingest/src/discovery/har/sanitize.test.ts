import { describe, expect, test } from "bun:test";
import { parseHar, type HarEntry, type HarFile } from "./har-schema.ts";
import { MAX_BODY_CHARS, REDACTED, sanitizeHar, TRUNCATED_MARKER } from "./sanitize.ts";

interface EntrySpec {
  method?: string;
  url: string;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
  postDataText?: string;
  mimeType?: string;
  body?: string;
  encoding?: string;
}

function harOf(...specs: EntrySpec[]): HarFile {
  return parseHar({
    log: {
      version: "1.2",
      entries: specs.map((s) => {
        const u = new URL(s.url);
        return {
          startedDateTime: "2026-07-19T00:00:00.000Z",
          request: {
            method: s.method ?? "GET",
            url: s.url,
            headers: s.requestHeaders ?? [],
            queryString: [...u.searchParams].map(([name, value]) => ({ name, value })),
            ...(s.postDataText !== undefined
              ? { postData: { mimeType: "application/json", text: s.postDataText } }
              : {}),
          },
          response: {
            status: 200,
            headers: s.responseHeaders ?? [],
            content: {
              mimeType: s.mimeType ?? "application/json",
              ...(s.body !== undefined ? { text: s.body } : {}),
              ...(s.encoding !== undefined ? { encoding: s.encoding } : {}),
            },
          },
        };
      }),
    },
  });
}

function onlyEntry(har: HarFile): HarEntry {
  expect(har.log.entries).toHaveLength(1);
  return har.log.entries[0]!;
}

describe("sanitizeHar — header redaction", () => {
  test("sensitive request AND response headers are redacted, benign headers survive", () => {
    const { har, stats } = sanitizeHar(
      harOf({
        url: "https://www.promart.pe/api/search?q=tv",
        requestHeaders: [
          { name: "cookie", value: "sessionid=live" },
          { name: "authorization", value: "Bearer live-token" },
          { name: "x-csrf-token", value: "csrf-live" },
          { name: "accept", value: "application/json" },
        ],
        responseHeaders: [
          { name: "set-cookie", value: "sid=live; HttpOnly" },
          { name: "content-type", value: "application/json" },
        ],
        body: "{}",
      }),
    );

    const entry = onlyEntry(har);
    const reqHeaders = Object.fromEntries(entry.request.headers.map((h) => [h.name, h.value]));
    expect(reqHeaders["cookie"]).toBe(REDACTED);
    expect(reqHeaders["authorization"]).toBe(REDACTED);
    expect(reqHeaders["x-csrf-token"]).toBe(REDACTED);
    expect(reqHeaders["accept"]).toBe("application/json");
    const resHeaders = Object.fromEntries(entry.response.headers.map((h) => [h.name, h.value]));
    expect(resHeaders["set-cookie"]).toBe(REDACTED);
    expect(resHeaders["content-type"]).toBe("application/json");
    expect(stats.redactedHeaders).toBe(4);
  });
});

describe("sanitizeHar — query parameter redaction", () => {
  test("sensitive params are redacted in BOTH request.url and request.queryString", () => {
    const { har } = sanitizeHar(
      harOf({ url: "https://simple.ripley.com.pe/api/search?q=tv&token=abc123&sig=xyz" }),
    );

    const entry = onlyEntry(har);
    const url = new URL(entry.request.url);
    expect(url.searchParams.get("token")).toBe(REDACTED);
    expect(url.searchParams.get("sig")).toBe(REDACTED);
    expect(url.searchParams.get("q")).toBe("tv");
    const qs = Object.fromEntries(entry.request.queryString.map((p) => [p.name, p.value]));
    expect(qs["token"]).toBe(REDACTED);
    expect(qs["sig"]).toBe(REDACTED);
    expect(qs["q"]).toBe("tv");
  });
});

describe("sanitizeHar — postData redaction", () => {
  test("JSON postData is deep-redacted by key at any nesting depth", () => {
    const { har } = sanitizeHar(
      harOf({
        method: "POST",
        url: "https://www.promart.pe/api/cart",
        postDataText: JSON.stringify({
          items: [{ sku: "1", sessionToken: "live" }],
          nested: { deeper: { api_key: "live" } },
          keep: "me",
        }),
      }),
    );

    const text = onlyEntry(har).request.postData?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.items[0].sku).toBe("1");
    expect(parsed.items[0].sessionToken).toBe(REDACTED);
    expect(parsed.nested.deeper.api_key).toBe(REDACTED);
    expect(parsed.keep).toBe("me");
  });

  test("non-JSON postData cannot be inspected → replaced entirely", () => {
    const { har, stats } = sanitizeHar(
      harOf({
        method: "POST",
        url: "https://www.promart.pe/api/form",
        postDataText: "user=pepe&password=hunter2",
      }),
    );

    expect(onlyEntry(har).request.postData?.text).toBe(REDACTED);
    expect(stats.redactedPostData).toBe(1);
  });
});

describe("sanitizeHar — host allowlist", () => {
  test("entries on non-allowlisted hosts are dropped; store + image CDN hosts are kept", () => {
    const { har, stats } = sanitizeHar(
      harOf(
        { url: "https://www.promart.pe/api/search?q=tv", body: "{}" },
        { url: "https://promart.vteximg.com.br/img/1.png", mimeType: "image/png" },
        { url: "https://tracker.evil.example/pixel.gif", mimeType: "image/gif" },
        { url: "https://www.google-analytics.com/collect", mimeType: "image/gif" },
      ),
    );

    expect(har.log.entries.map((e) => new URL(e.request.url).hostname)).toEqual([
      "www.promart.pe",
      "promart.vteximg.com.br",
    ]);
    expect(stats.entries).toBe(4);
    expect(stats.kept).toBe(2);
    expect(stats.droppedForeignHost).toBe(2);
  });
});

describe("sanitizeHar — response bodies", () => {
  test("base64-encoded bodies are dropped (cannot be inspected for secrets)", () => {
    const { har, stats } = sanitizeHar(
      harOf({
        url: "https://promart.vteximg.com.br/img/1.png",
        mimeType: "image/png",
        body: "iVBORw0KGgo=",
        encoding: "base64",
      }),
    );

    expect(onlyEntry(har).response.content?.text).toBeUndefined();
    expect(stats.droppedEncodedBodies).toBe(1);
  });

  test("bodies over the cap are truncated with an explicit marker", () => {
    const big = "x".repeat(MAX_BODY_CHARS + 100);
    const { har, stats } = sanitizeHar(
      harOf({ url: "https://www.promart.pe/big.json", body: big }),
    );

    const text = onlyEntry(har).response.content?.text!;
    expect(text.length).toBe(MAX_BODY_CHARS + TRUNCATED_MARKER.length);
    expect(text.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(text.startsWith("x".repeat(100))).toBe(true);
    expect(stats.truncatedBodies).toBe(1);
  });
});

describe("sanitizeHar — stats and purity", () => {
  test("stats count every redaction/drop category exactly", () => {
    const { stats } = sanitizeHar(
      harOf(
        {
          // 3 header redactions (cookie, x-api-key, set-cookie), 2 param redactions
          // (token in url + queryString).
          url: "https://www.promart.pe/api/search?q=tv&token=abc",
          requestHeaders: [
            { name: "cookie", value: "live" },
            { name: "x-api-key", value: "live" },
          ],
          responseHeaders: [{ name: "set-cookie", value: "live" }],
          body: "{}",
        },
        {
          // JSON postData: sessionToken + auth keys → 2 param redactions, 1 postData.
          method: "POST",
          url: "https://simple.ripley.com.pe/api/cart",
          postDataText: JSON.stringify({ sessionToken: "live", auth: { code: "live" } }),
          body: "{}",
        },
        {
          // Non-JSON postData → 1 postData redaction.
          method: "POST",
          url: "https://www.falabella.com.pe/api/form",
          postDataText: "a=1&b=2",
          body: "{}",
        },
        // Foreign host drop.
        { url: "https://ads.example.com/x.js", mimeType: "text/javascript" },
        {
          // Base64 body drop.
          url: "https://media.falabella.com.pe/i.png",
          mimeType: "image/png",
          body: "QUJD",
          encoding: "base64",
        },
        {
          // Truncation.
          url: "https://www.promart.pe/big.json",
          body: "y".repeat(MAX_BODY_CHARS + 1),
        },
      ),
    );

    expect(stats).toEqual({
      entries: 6,
      kept: 5,
      droppedForeignHost: 1,
      redactedHeaders: 3,
      redactedParams: 4,
      redactedPostData: 2,
      droppedEncodedBodies: 1,
      truncatedBodies: 1,
    });
  });

  test("the input HAR object is never mutated", () => {
    const input = harOf({
      url: "https://www.promart.pe/api/search?token=abc&q=tv",
      requestHeaders: [{ name: "cookie", value: "live" }],
      body: "{}",
    });
    const snapshot = structuredClone(input);

    sanitizeHar(input);

    expect(input).toEqual(snapshot);
  });
});
