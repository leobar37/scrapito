#!/usr/bin/env bun
/** One-shot script to drain pending image sources for a given run. */
import { openWriterDatabase, CatalogStore } from "@scrapito/catalog/write";
import { CrawlPolicy, defaultHttpFetch, defaultImageFetch } from "./src/policy/crawl-policy.ts";
import { ImageWorker } from "./src/images/image-worker.ts";

const dbPath = process.env.SCRAP_DB_PATH!;
const storageDir = process.env.SCRAP_STORAGE_DIR!;
const userAgent = process.env.SCRAP_USER_AGENT!;
const runId = Number(process.env.RUN_ID ?? 1);
const limit = Number(process.env.LIMIT ?? 1000);

const db = openWriterDatabase(dbPath);
const catalog = new CatalogStore(db);
const policy = new CrawlPolicy({ userAgent, httpFetch: defaultHttpFetch(), imageFetch: defaultImageFetch() });
const worker = new ImageWorker(policy, catalog, storageDir);

const result = await worker.processRun(runId, limit);
console.log(JSON.stringify(result));
db.close();
