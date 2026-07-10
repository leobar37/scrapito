import { describe, expect, test } from "bun:test";
import { extractJsonLd, extractNextData, findJsonLdByType, flattenJsonLd } from "./html-extract.ts";

describe("extractNextData", () => {
  test("returns undefined when the __NEXT_DATA__ script is missing", () => {
    const html = "<!doctype html><html><head><title>no data</title></head><body>hi</body></html>";
    expect(extractNextData(html)).toBeUndefined();
  });

  test("returns undefined when the script body is malformed JSON", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"props": not valid json</script>';
    expect(extractNextData(html)).toBeUndefined();
  });

  test("parses a valid __NEXT_DATA__ payload", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"foo":"bar"}}}</script>';
    const data = extractNextData<{ props: { pageProps: { foo: string } } }>(html);
    expect(data?.props.pageProps.foo).toBe("bar");
  });
});

describe("extractJsonLd / flattenJsonLd", () => {
  test("returns an empty array when there are no ld+json blocks", () => {
    expect(extractJsonLd("<html><body>none here</body></html>")).toEqual([]);
  });

  test("skips a malformed block but keeps parsing the well-formed ones", () => {
    const html = `
      <script type="application/ld+json">{ not json at all </script>
      <script type="application/ld+json">{"@type":"BreadcrumbList","@context":"https://schema.org"}</script>
    `;
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    expect(flattenJsonLd(blocks)[0]?.["@type"]).toBe("BreadcrumbList");
  });

  test("extracts multiple well-formed blocks in document order", () => {
    const html = `
      <script type="application/ld+json">{"@type":"BreadcrumbList","@context":"https://schema.org"}</script>
      <script type="application/ld+json">{"@type":"Product","@context":"https://schema.org","name":"Foo"}</script>
    `;
    const blocks = flattenJsonLd(extractJsonLd(html));
    expect(blocks.map((b) => b["@type"])).toEqual(["BreadcrumbList", "Product"]);
  });

  test("flattenJsonLd expands @graph arrays so nested nodes are discoverable", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"BreadcrumbList"},
        {"@type":"Product","name":"Graphed Product"}
      ]}
    </script>`;
    const nodes = flattenJsonLd(extractJsonLd(html));
    // The wrapper node itself plus its two graph members.
    expect(nodes.some((n) => n["@type"] === "Product" && n["name"] === "Graphed Product")).toBe(
      true,
    );
  });
});

describe("findJsonLdByType", () => {
  test("finds the matching node among multiple JSON-LD blocks of different types", () => {
    const html = `
      <script type="application/ld+json">{"@type":"BreadcrumbList","@context":"https://schema.org","itemListElement":[]}</script>
      <script type="application/ld+json">{"@type":"Product","@context":"https://schema.org","name":"Laptop","sku":"123"}</script>
    `;
    const node = findJsonLdByType(html, "Product");
    expect(node?.["name"]).toBe("Laptop");
  });

  test("matches when @type is an array containing the requested type", () => {
    const html = `<script type="application/ld+json">{"@type":["Product","SomethingElse"],"name":"Multi"}</script>`;
    expect(findJsonLdByType(html, "Product")?.["name"]).toBe("Multi");
  });

  test("returns undefined when no block matches the requested type", () => {
    const html = `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`;
    expect(findJsonLdByType(html, "Product")).toBeUndefined();
  });
});
