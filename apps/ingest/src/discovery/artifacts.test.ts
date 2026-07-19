import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsDiscoveryArtifacts, sha256Hex } from "./artifacts.ts";
import type { DiscoveryManifestMeta } from "./define-discovery.ts";

const tmpDirs: string[] = [];

function makeRun(): { base: string; artifacts: FsDiscoveryArtifacts } {
  const base = mkdtempSync(join(tmpdir(), "discovery-artifacts-"));
  tmpDirs.push(base);
  return { base, artifacts: new FsDiscoveryArtifacts(base, "run-1") };
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const META: DiscoveryManifestMeta = {
  scraperId: "promart-pe",
  store: "promart-pe",
  startedAt: "2026-07-19T00:00:00.000Z",
  userAgent: "scrapito-test (+https://example.com/bot)",
  scenarios: ["home"],
  harAvailable: true,
};

describe("sha256Hex", () => {
  test("matches the well-known SHA-256 of a fixed string", () => {
    // Defends the hashing primitive every integrity check binds to.
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("hashes binary content identically to its UTF-8 string form", () => {
    const text = "evidence-ñ";
    expect(sha256Hex(new Uint8Array(Buffer.from(text, "utf8")))).toBe(sha256Hex(text));
  });
});

describe("FsDiscoveryArtifacts.save", () => {
  test("writes the file inside the run dir and records a matching hash + byte count", () => {
    const { artifacts } = makeRun();
    const path = artifacts.save("home.html", "<html>hi</html>");

    expect(path).toBe(join(artifacts.dir, "home.html"));
    expect(readFileSync(path, "utf8")).toBe("<html>hi</html>");
    const entry = artifacts.manifestEntries()[0]!;
    expect(entry.name).toBe("home.html");
    expect(entry.sha256).toBe(sha256Hex("<html>hi</html>"));
    expect(entry.bytes).toBe(Buffer.byteLength("<html>hi</html>"));
  });

  test("creates intermediate directories for nested artifact names", () => {
    const { artifacts } = makeRun();
    const path = artifacts.save("samples/000.response.json", "{}");
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  test("records byte length of binary content, not string length", () => {
    const { artifacts } = makeRun();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    artifacts.save("shot.png", bytes);
    expect(artifacts.manifestEntries()[0]!.bytes).toBe(4);
    expect(artifacts.manifestEntries()[0]!.sha256).toBe(sha256Hex(bytes));
  });

  test("rejects path traversal outside the run dir", () => {
    const { artifacts } = makeRun();
    expect(() => artifacts.save("../escape.txt", "x")).toThrow(/inside the run dir/);
    expect(() => artifacts.save("nested/../../escape.txt", "x")).toThrow(/inside the run dir/);
    expect(() => artifacts.save("/absolute.txt", "x")).toThrow(/inside the run dir/);
    expect(existsSync(join(artifacts.dir, "..", "escape.txt"))).toBe(false);
  });
});

describe("FsDiscoveryArtifacts.saveJson", () => {
  test("round-trips data through the saved file", () => {
    const { artifacts } = makeRun();
    const data = { url: "https://www.promart.pe/", requests: [{ method: "GET", status: 200 }] };
    const path = artifacts.saveJson("home.requests.json", data);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(data);
  });
});

describe("FsDiscoveryArtifacts.writeManifest", () => {
  test("freezes schemaVersion, run meta and every previously saved artifact", () => {
    const { artifacts } = makeRun();
    artifacts.save("home.html", "<html></html>");
    artifacts.saveJson("home.requests.json", [{ url: "https://www.promart.pe/", method: "GET" }]);

    const manifestPath = artifacts.writeManifest(META);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.scraperId).toBe(META.scraperId);
    expect(manifest.store).toBe(META.store);
    expect(manifest.startedAt).toBe(META.startedAt);
    expect(manifest.userAgent).toBe(META.userAgent);
    expect(manifest.scenarios).toEqual(["home"]);
    expect(manifest.harAvailable).toBe(true);
    expect(typeof manifest.finishedAt).toBe("string");
    expect(manifest.artifacts.map((a: { name: string }) => a.name)).toEqual([
      "home.html",
      "home.requests.json",
    ]);
    expect(manifest.artifacts[0].sha256).toBe(sha256Hex("<html></html>"));
  });

  test("the manifest's own recorded hash matches the bytes on disk (verify self-consistency)", () => {
    const { artifacts } = makeRun();
    artifacts.save("home.html", "abc");
    const manifestPath = artifacts.writeManifest(META);

    // verify.ts re-hashes manifest.json against its own manifest entry; if
    // writeManifest recorded anything but the real bytes, every run would
    // fail integrity on itself.
    const selfEntry = artifacts.manifestEntries().find((e) => e.name === "manifest.json")!;
    expect(selfEntry.sha256).toBe(sha256Hex(new Uint8Array(readFileSync(manifestPath))));
  });
});
