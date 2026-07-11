-- 0003_variants_and_image_targets.sql — authoritative product variants and a
-- run-owned image-destination model. image_sources becomes a canonical
-- URL/download-state table (no product ownership); image_source_targets links
-- a canonical source to a product OR variant destination, scoped either to a
-- specific ingestion run or (historically) to no run.

PRAGMA foreign_keys = OFF;

CREATE TABLE product_variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  sku             TEXT,
  name            TEXT,
  color_name      TEXT,
  color_hex       TEXT,
  size            TEXT,
  in_stock        INTEGER NOT NULL DEFAULT 1,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  active          INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  UNIQUE(product_id, external_id)
);
CREATE INDEX idx_product_variants_product_active ON product_variants(product_id, active);

CREATE TABLE variant_images (
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL REFERENCES images(sha256),
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, sha256, position)
);

-- Rebuild image_sources as canonical, product/variant-agnostic download state.
CREATE TABLE image_sources_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL UNIQUE,
  sha256        TEXT REFERENCES images(sha256),
  etag          TEXT,
  last_modified TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

-- One canonical row per distinct URL, folding duplicate per-product rows that
-- previously existed for the same URL under different products.
INSERT INTO image_sources_new (url, sha256, etag, last_modified, status, attempts, last_error, created_at)
SELECT
  url,
  (SELECT sha256 FROM image_sources s2 WHERE s2.url = s1.url AND s2.sha256 IS NOT NULL LIMIT 1),
  (SELECT etag FROM image_sources s2 WHERE s2.url = s1.url AND s2.etag IS NOT NULL LIMIT 1),
  (SELECT last_modified FROM image_sources s2 WHERE s2.url = s1.url AND s2.last_modified IS NOT NULL LIMIT 1),
  CASE
    WHEN EXISTS (SELECT 1 FROM image_sources s2 WHERE s2.url = s1.url AND s2.status = 'done') THEN 'done'
    WHEN EXISTS (SELECT 1 FROM image_sources s2 WHERE s2.url = s1.url AND s2.status = 'failed')
      AND NOT EXISTS (SELECT 1 FROM image_sources s2 WHERE s2.url = s1.url AND s2.status = 'pending') THEN 'failed'
    ELSE 'pending'
  END,
  (SELECT MAX(attempts) FROM image_sources s2 WHERE s2.url = s1.url),
  (SELECT last_error FROM image_sources s2 WHERE s2.url = s1.url AND s2.last_error IS NOT NULL LIMIT 1),
  (SELECT MIN(created_at) FROM image_sources s2 WHERE s2.url = s1.url)
FROM image_sources s1
GROUP BY url;

CREATE TABLE image_source_targets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        INTEGER NOT NULL REFERENCES image_sources_new(id) ON DELETE CASCADE,
  run_id           INTEGER REFERENCES scraper_runs(id) ON DELETE SET NULL,
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('product', 'variant')),
  destination_id   INTEGER NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  alt              TEXT
);

-- Runtime writes always carry a non-null run_id; this partial index dedupes
-- per-run destinations.
CREATE UNIQUE INDEX idx_image_source_targets_run
  ON image_source_targets(source_id, run_id, destination_kind, destination_id, position)
  WHERE run_id IS NOT NULL;

-- Historical (pre-migration) rows have no owning run; this partial index
-- dedupes those instead.
CREATE UNIQUE INDEX idx_image_source_targets_null_run
  ON image_source_targets(source_id, destination_kind, destination_id, position)
  WHERE run_id IS NULL;

CREATE INDEX idx_image_source_targets_dest ON image_source_targets(destination_kind, destination_id);

-- Preserve every old (product_id, url, position, alt) link as a null-run
-- (historical) target so downloaded links and pending rows both survive.
INSERT INTO image_source_targets (source_id, run_id, destination_kind, destination_id, position, alt)
SELECT n.id, NULL, 'product', o.product_id, COALESCE(o.position, 0), o.alt
FROM image_sources o
JOIN image_sources_new n ON n.url = o.url;

DROP TABLE image_sources;
ALTER TABLE image_sources_new RENAME TO image_sources;
CREATE INDEX idx_image_sources_status ON image_sources(status);

PRAGMA foreign_keys = ON;
