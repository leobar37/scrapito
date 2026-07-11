-- 0001_init.sql — core catalog, history, jobs, tabs, crawl state, image metadata.

CREATE TABLE stores (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  base_url TEXT NOT NULL
);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT NOT NULL REFERENCES stores(id),
  external_id TEXT NOT NULL,
  parent_id   INTEGER REFERENCES categories(id),
  name        TEXT NOT NULL,
  url         TEXT,
  UNIQUE(store_id, external_id)
);

CREATE TABLE products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL REFERENCES stores(id),
  external_id     TEXT NOT NULL,
  canonical_url   TEXT NOT NULL,
  name            TEXT NOT NULL,
  brand           TEXT,
  seller_id       TEXT,
  seller_name     TEXT,
  sponsored       INTEGER NOT NULL DEFAULT 0,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  source_hash     TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  UNIQUE(store_id, external_id)
);

CREATE TABLE product_categories (
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE price_observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  observed_at   TEXT NOT NULL,
  regular_cents INTEGER,
  offer_cents   INTEGER,
  card_cents    INTEGER,
  currency      TEXT NOT NULL DEFAULT 'PEN' CHECK (currency = 'PEN'),
  seller_id     TEXT,
  in_stock      INTEGER NOT NULL DEFAULT 1,
  raw_json      TEXT
);
CREATE INDEX idx_price_obs_product ON price_observations(product_id, observed_at);

CREATE TABLE images (
  sha256        TEXT PRIMARY KEY,
  byte_size     INTEGER NOT NULL,
  mime          TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  relative_path TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE image_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  position      INTEGER,
  alt           TEXT,
  sha256        TEXT REFERENCES images(sha256),
  etag          TEXT,
  last_modified TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(product_id, url)
);
CREATE INDEX idx_image_sources_status ON image_sources(status);

CREATE TABLE product_images (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL REFERENCES images(sha256),
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, sha256)
);

CREATE TABLE scraper_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  scraper_id         TEXT NOT NULL,
  store_id           TEXT NOT NULL REFERENCES stores(id),
  job_id             INTEGER REFERENCES scrape_jobs(id),
  status             TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  products_saved     INTEGER NOT NULL DEFAULT 0,
  products_rejected  INTEGER NOT NULL DEFAULT 0,
  requests_made      INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT
);

CREATE TABLE scraper_run_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES scraper_runs(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  data_json  TEXT
);

CREATE TABLE scrape_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scraper_id      TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_requests    INTEGER NOT NULL,
  max_duration_ms INTEGER NOT NULL,
  scheduled_at    TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  products_saved  INTEGER NOT NULL DEFAULT 0,
  products_rejected INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON scrape_jobs(status, scheduled_at);

CREATE TABLE browser_tabs (
  session    TEXT NOT NULL,
  tab_id     TEXT NOT NULL,
  label      TEXT,
  url        TEXT,
  purpose    TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session, tab_id)
);

CREATE TABLE crawl_state (
  host          TEXT PRIMARY KEY,
  circuit_state TEXT NOT NULL DEFAULT 'closed',
  opened_at     TEXT,
  cooldown_ms   INTEGER,
  updated_at    TEXT NOT NULL
);

CREATE TABLE http_cache (
  url           TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  body_hash     TEXT,
  status        INTEGER NOT NULL,
  fetched_at    INTEGER NOT NULL,
  fresh_until   INTEGER NOT NULL
);

-- Full-text search over product name/brand/seller, maintained by triggers.
CREATE VIRTUAL TABLE products_fts USING fts5(
  name, brand, seller_name,
  content='products', content_rowid='id'
);

CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, brand, seller_name)
  VALUES (new.id, new.name, coalesce(new.brand,''), coalesce(new.seller_name,''));
END;

CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, brand, seller_name)
  VALUES ('delete', old.id, old.name, coalesce(old.brand,''), coalesce(old.seller_name,''));
END;

CREATE TRIGGER products_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, brand, seller_name)
  VALUES ('delete', old.id, old.name, coalesce(old.brand,''), coalesce(old.seller_name,''));
  INSERT INTO products_fts(rowid, name, brand, seller_name)
  VALUES (new.id, new.name, coalesce(new.brand,''), coalesce(new.seller_name,''));
END;

INSERT INTO stores(id, name, base_url) VALUES
  ('ripley-pe', 'Ripley Peru', 'https://simple.ripley.com.pe'),
  ('falabella-pe', 'Falabella Peru', 'https://www.falabella.com.pe');
