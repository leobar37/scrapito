import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactManifestEntry,
  DiscoveryArtifacts,
  DiscoveryManifestMeta,
} from "./define-discovery.ts";

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Filesystem-backed discovery artifacts under `data/discovery/<run-id>/`.
 * Every saved artifact is hashed; `writeManifest` freezes the inventory so a
 * later `discover verify` can detect tampering or missing evidence. */
export class FsDiscoveryArtifacts implements DiscoveryArtifacts {
  readonly dir: string;
  private readonly entries: ArtifactManifestEntry[] = [];

  constructor(baseDir: string, runId: string) {
    this.dir = join(baseDir, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  save(name: string, content: string | Uint8Array): string {
    if (name.includes("..") || name.startsWith("/")) {
      throw new Error(`artifact name must stay inside the run dir: ${name}`);
    }
    const path = join(this.dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    this.entries.push({
      name,
      sha256: sha256Hex(content),
      bytes: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength,
      savedAt: new Date().toISOString(),
    });
    return path;
  }

  saveJson(name: string, data: unknown): string {
    return this.save(name, JSON.stringify(data, null, 2));
  }

  manifestEntries(): readonly ArtifactManifestEntry[] {
    return this.entries;
  }

  writeManifest(meta: DiscoveryManifestMeta): string {
    return this.save("manifest.json", JSON.stringify({
      schemaVersion: 1,
      ...meta,
      finishedAt: new Date().toISOString(),
      artifacts: this.entries,
    }, null, 2));
  }
}
