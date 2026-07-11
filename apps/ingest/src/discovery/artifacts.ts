import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryArtifacts } from "./define-discovery.ts";

/** Filesystem-backed discovery artifacts under `data/discovery/<run-id>/`. */
export class FsDiscoveryArtifacts implements DiscoveryArtifacts {
  readonly dir: string;

  constructor(baseDir: string, runId: string) {
    this.dir = join(baseDir, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  save(name: string, content: string | Uint8Array): string {
    const path = join(this.dir, name);
    writeFileSync(path, content);
    return path;
  }

  saveJson(name: string, data: unknown): string {
    return this.save(name, JSON.stringify(data, null, 2));
  }
}
