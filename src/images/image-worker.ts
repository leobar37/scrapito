/**
 * ImageWorker — drains queued image_sources, downloads each through CrawlPolicy,
 * deduplicates by SHA-256, stores bytes atomically, and links product_images.
 * A single image failure records the error and never rolls back the product.
 */
import type { CrawlPolicy } from "../policy/crawl-policy.ts";
import type { RequestBudget } from "../policy/budget.ts";
import type { CatalogStore } from "../persistence/catalog-store.ts";
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

  /** Process up to `limit` pending image sources. */
  async processPending(limit = 50, budget?: RequestBudget): Promise<ImageWorkerResult> {
    const result: ImageWorkerResult = { processed: 0, downloaded: 0, deduped: 0, failed: 0 };
    const pending = this.catalog.claimPendingImageSources(limit);
    for (const source of pending) {
      result.processed++;
      try {
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
        this.catalog.linkProductImage(source.product_id, image.sha256, source.position ?? 0);
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

