/**
 * Content-addressed image storage. Files land at
 * `<storageDir>/images/<sha[0:2]>/<sha[2:4]>/<sha>.<ext>` where the extension is
 * derived from the validated MIME type. Writes are atomic (temp file + rename).
 */
import { mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** Extension for a validated image MIME, defaulting to `bin` for unknowns. */
export function extensionForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? "bin";
}

/** Relative storage path (POSIX) for a sha + extension. */
export function relativeImagePath(sha256: string, ext: string): string {
  return `images/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`;
}

/** Write bytes atomically to the content-addressed path; returns relative path. */
export function storeImage(storageDir: string, sha256: string, mime: string, bytes: Uint8Array): string {
  const ext = extensionForMime(mime);
  const relative = relativeImagePath(sha256, ext);
  const absolute = join(storageDir, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  const temp = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, bytes);
    renameSync(temp, absolute);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  return relative;
}
