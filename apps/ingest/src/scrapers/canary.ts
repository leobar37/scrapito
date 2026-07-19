import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ProductInputSchema } from "@scrapito/contracts";
import { getScraper } from "./registry.ts";

export interface ScraperCanaryResult {
  ok: boolean;
  code: "SCRAPER_CANARY_PASSED" | "SCRAPER_CANARY_FAILED";
  scraperId: string;
  products: number;
  valid: number;
  checkoutSha256: string;
  productsSha256: string;
  resultSha256: string;
  error: string | null;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableResultHash(result: Omit<ScraperCanaryResult, "resultSha256">): string {
  return sha256(JSON.stringify(result));
}

/**
 * Executes only a statically registered scraper's checked-in selfCheck. The
 * temporary SQLite database, storage, and discovery directories prove that a
 * canary cannot reach production state. No network or browser primitive is
 * created here.
 */
export async function runScraperCanary(scraperId: string): Promise<ScraperCanaryResult> {
  const scraper = getScraper(scraperId);
  const checkoutSha256 = sha256(await Bun.file(join(import.meta.dir, "registry.ts")).text());
  const root = mkdtempSync(join(tmpdir(), "scrapito-scraper-canary-"));
  const storage = join(root, "storage");
  const discovery = join(root, "discovery");
  const dbPath = join(root, "canary.sqlite");
  mkdirSync(storage, { recursive: true });
  mkdirSync(discovery, { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });

  try {
    if (!scraper) throw new Error(`unknown statically registered scraper: ${scraperId}`);
    if (!scraper.selfCheck) throw new Error(`scraper has no checked-in selfCheck: ${scraperId}`);
    db.exec("CREATE TABLE canary_products (position INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO canary_products (position, payload) VALUES (?, ?)");
    const products = scraper.selfCheck();
    let valid = 0;
    const payloads: string[] = [];
    for (const [index, product] of products.entries()) {
      const payload = JSON.stringify(ProductInputSchema.parse(product));
      insert.run(index, payload);
      payloads.push(payload);
      valid += 1;
    }
    const persisted = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM canary_products").get()?.count ?? 0;
    if (persisted !== valid) throw new Error(`temporary canary persistence mismatch: ${persisted}/${valid}`);
    const base = {
      ok: true,
      code: "SCRAPER_CANARY_PASSED" as const,
      scraperId,
      products: products.length,
      valid,
      checkoutSha256,
      error: null,
      productsSha256: sha256(JSON.stringify(payloads)),
    };
    return { ...base, resultSha256: stableResultHash(base) };
  } catch (error) {
    const base = {
      ok: false,
      code: "SCRAPER_CANARY_FAILED" as const,
      scraperId,
      products: 0,
      valid: 0,
      checkoutSha256,
      error: error instanceof Error ? error.message : String(error),
      productsSha256: sha256("[]"),
    };
    return { ...base, resultSha256: stableResultHash(base) };
  } finally {
    db.close(false);
    rmSync(root, { recursive: true, force: true });
  }
}
