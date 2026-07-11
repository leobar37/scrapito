import { describe, expect, test } from "bun:test";
import { resolveImageUrl } from "./api-client.ts";

describe("resolveImageUrl", () => {
  test("returns null for a null path", () => {
    expect(resolveImageUrl(null)).toBeNull();
  });

  test("passes through an already-absolute URL unchanged", () => {
    expect(resolveImageUrl("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
  });

  test("resolves an API-relative path against the current API base", () => {
    process.env.API_BASE_URL = "http://127.0.0.1:3000";
    expect(resolveImageUrl("/images/abc123")).toBe("http://127.0.0.1:3000/images/abc123");
  });
});
