/**
 * ImageWorker — drains pending image_sources OWNED (via a target) by a given
 * ingestion run, downloads each distinct URL through CrawlPolicy at most once
 * (reusing an already-archived SHA-256 without any network call), and links
 * the resulting image to every product/variant target for that source. A
 * single image failure records the error and never rolls back product/variant
 * rows. Historical (null-run) targets are never implicitly drained here.
 */
import type { CrawlPolicy } from "../policy/crawl-policy.ts";
import type { RequestBudget } from "../policy/budget.ts";
import type { CatalogStore } from "@scrapito/catalog/write";
import { nullLogger, type Logger } from "../util/logger.ts";
import { extensionForMime, relativeImagePath, storeImage } from "./image-storage.ts";

export interface ImageWorkerResult {
  processed: number;
  downloaded: number;
  deduped: number;
  failed: number;
}

export class ImageWorker {
  private readonly logger: Logger;

  constructor(
    private readonly policy: CrawlPolicy,
    private readonly catalog: CatalogStore,
    private readonly storageDir: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? nullLogger;
  }

  /** Process up to `limit` pending image sources owned by `runId`. */
  async processRun(runId: number, limit = 200, budget?: RequestBudget): Promise<ImageWorkerResult> {
    const result: ImageWorkerResult = { processed: 0, downloaded: 0, deduped: 0, failed: 0 };
    const pending = this.catalog.claimPendingImageSourcesForRun(runId, limit);
    for (const source of pending) {
      result.processed++;
      try {
        if (source.sha256) {
          // Already archived by a prior source row sharing this URL — reuse
          // without any network call, just link every target.
          this.catalog.linkImageToTargets(source.id, source.sha256);
          this.catalog.markImageSourceDone(source.id, source.sha256);
          result.deduped++;
          continue;
        }
        const image = await this.policy.fetchImage(source.url, { budget });
        const isNew = this.catalog.upsertImage({
          sha256: image.sha256,
          byteSize: image.bytes.byteLength,
          mime: image.mime,
          width: null,
          height: null,
          relativePath: relativeImagePath(image.sha256, extensionForMime(image.mime)),
        });
        if (isNew) {
          storeImage(this.storageDir, image.sha256, image.mime, image.bytes);
          result.downloaded++;
        } else {
          result.deduped++;
        }
        this.catalog.updateImageSourceValidators(source.id, image.etag, image.lastModified);
        this.catalog.linkImageToTargets(source.id, image.sha256);
        this.catalog.markImageSourceDone(source.id, image.sha256);
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        this.catalog.markImageSourceFailed(source.id, message);
        this.logger.warn("image download failed", { url: source.url, error: message });
      }
    }
    return result;
  }
}
