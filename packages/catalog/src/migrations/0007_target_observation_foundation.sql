-- 0007_target_observation_foundation.sql — additive target/run provenance,
-- authoritative coverage, product sightings, membership evidence and derived
-- temporal price movement views. Existing price_observations/current_offers
-- remain unchanged.

ALTER TABLE scraper_runs ADD COLUMN invocation_id TEXT;
ALTER TABLE scraper_runs ADD COLUMN strategy TEXT;
ALTER TABLE scraper_runs ADD COLUMN capability TEXT;
ALTER TABLE scraper_runs ADD COLUMN params_json TEXT;
ALTER TABLE scraper_runs ADD COLUMN max_requests INTEGER CHECK (max_requests IS NULL OR max_requests > 0);
ALTER TABLE scraper_runs ADD COLUMN max_duration_ms INTEGER CHECK (max_duration_ms IS NULL OR max_duration_ms > 0);

CREATE TABLE scrape_target_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      TEXT NOT NULL REFERENCES stores(id),
  kind          TEXT NOT NULL CHECK (kind IN ('homepage', 'trending', 'category', 'product')),
  identity_key  TEXT NOT NULL,
  target_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(store_id, identity_key)
);
CREATE INDEX idx_scrape_targets_store_kind
  ON scrape_target_identities(store_id, kind, id);

CREATE TABLE target_coverages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL REFERENCES scraper_runs(id) ON DELETE CASCADE,
  target_id          INTEGER NOT NULL REFERENCES scrape_target_identities(id),
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  authoritative      INTEGER NOT NULL DEFAULT 0 CHECK (authoritative IN (0, 1)),
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  max_requests       INTEGER CHECK (max_requests IS NULL OR max_requests > 0),
  max_duration_ms    INTEGER CHECK (max_duration_ms IS NULL OR max_duration_ms > 0),
  requested_pages_json TEXT,
  requests_made      INTEGER NOT NULL DEFAULT 0 CHECK (requests_made >= 0),
  products_seen      INTEGER NOT NULL DEFAULT 0 CHECK (products_seen >= 0),
  duplicates_seen    INTEGER NOT NULL DEFAULT 0 CHECK (duplicates_seen >= 0),
  products_rejected  INTEGER NOT NULL DEFAULT 0 CHECK (products_rejected >= 0),
  stop_reason        TEXT CHECK (stop_reason IS NULL OR stop_reason IN
                       ('completed', 'budget_exhausted', 'challenge', 'circuit_open',
                        'error', 'cancelled', 'ingest_restarted')),
  boundary_json      TEXT,
  UNIQUE(run_id, target_id),
  UNIQUE(id, target_id),
  CHECK (authoritative = 0 OR status = 'complete'),
  CHECK ((status = 'running' AND finished_at IS NULL AND stop_reason IS NULL)
      OR (status <> 'running' AND finished_at IS NOT NULL AND stop_reason IS NOT NULL))
);
CREATE INDEX idx_target_coverages_target_latest
  ON target_coverages(target_id, started_at DESC, id DESC);
CREATE INDEX idx_target_coverages_run ON target_coverages(run_id, id);

CREATE TRIGGER target_coverages_authoritative_kind_insert
BEFORE INSERT ON target_coverages
WHEN NEW.authoritative = 1 AND EXISTS (
  SELECT 1 FROM scrape_target_identities t
  WHERE t.id = NEW.target_id AND t.kind IN ('homepage', 'trending')
)
BEGIN
  SELECT RAISE(ABORT, 'homepage/trending coverage cannot be authoritative');
END;

CREATE TRIGGER target_coverages_authoritative_kind_update
BEFORE UPDATE OF authoritative, status ON target_coverages
WHEN NEW.authoritative = 1 AND EXISTS (
  SELECT 1 FROM scrape_target_identities t
  WHERE t.id = NEW.target_id AND t.kind IN ('homepage', 'trending')
)
BEGIN
  SELECT RAISE(ABORT, 'homepage/trending coverage cannot be authoritative');
END;

-- Required for a composite FK proving that a sighting's price belongs to the
-- same product. The existing price change-log is not rewritten or backfilled.
CREATE UNIQUE INDEX uq_price_observations_id_product
  ON price_observations(id, product_id);
CREATE INDEX idx_price_observations_product_sequence
  ON price_observations(product_id, observed_at, id);

CREATE TABLE product_sightings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  coverage_id          INTEGER NOT NULL REFERENCES target_coverages(id) ON DELETE CASCADE,
  product_id           INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_observation_id INTEGER NOT NULL,
  seen_at              TEXT NOT NULL,
  source_hash          TEXT,
  UNIQUE(coverage_id, product_id),
  FOREIGN KEY (price_observation_id, product_id)
    REFERENCES price_observations(id, product_id)
);
CREATE INDEX idx_product_sightings_product_latest
  ON product_sightings(product_id, seen_at DESC, id DESC);
CREATE INDEX idx_product_sightings_price
  ON product_sightings(price_observation_id);

CREATE TABLE target_product_memberships (
  target_id                    INTEGER NOT NULL REFERENCES scrape_target_identities(id) ON DELETE CASCADE,
  product_id                   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  first_seen_at                TEXT NOT NULL,
  last_seen_at                 TEXT NOT NULL,
  last_seen_coverage_id        INTEGER NOT NULL,
  consecutive_complete_misses  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_complete_misses >= 0),
  inactive_at                  TEXT,
  inactivity_reason            TEXT CHECK (inactivity_reason IS NULL OR inactivity_reason IN
                                  ('complete_coverage_miss', 'explicit_source_signal')),
  PRIMARY KEY (target_id, product_id),
  FOREIGN KEY (last_seen_coverage_id, target_id)
    REFERENCES target_coverages(id, target_id),
  CHECK ((inactive_at IS NULL AND inactivity_reason IS NULL)
      OR (inactive_at IS NOT NULL AND inactivity_reason IS NOT NULL))
);
CREATE INDEX idx_target_memberships_product
  ON target_product_memberships(product_id, target_id);
CREATE INDEX idx_target_memberships_active_misses
  ON target_product_memberships(target_id, inactive_at, consecutive_complete_misses);

CREATE TRIGGER product_sightings_membership_insert
AFTER INSERT ON product_sightings
BEGIN
  INSERT INTO target_product_memberships
    (target_id, product_id, first_seen_at, last_seen_at, last_seen_coverage_id,
     consecutive_complete_misses, inactive_at, inactivity_reason)
  SELECT c.target_id, NEW.product_id, NEW.seen_at, NEW.seen_at, NEW.coverage_id,
         0, NULL, NULL
    FROM target_coverages c WHERE c.id = NEW.coverage_id
  ON CONFLICT(target_id, product_id) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    last_seen_coverage_id = excluded.last_seen_coverage_id,
    consecutive_complete_misses = 0,
    inactive_at = NULL,
    inactivity_reason = NULL;
END;

CREATE TRIGGER product_sightings_membership_update
AFTER UPDATE OF price_observation_id, seen_at, source_hash ON product_sightings
BEGIN
  UPDATE target_product_memberships
     SET last_seen_at = NEW.seen_at,
         last_seen_coverage_id = NEW.coverage_id,
         consecutive_complete_misses = 0,
         inactive_at = NULL,
         inactivity_reason = NULL
   WHERE target_id = (SELECT target_id FROM target_coverages WHERE id = NEW.coverage_id)
     AND product_id = NEW.product_id;
END;

CREATE VIEW price_observation_movements AS
WITH candidates AS (
  SELECT po.*,
         COALESCE(po.offer_cents, po.regular_cents) AS public_candidate
  FROM price_observations po
), effective AS (
  SELECT c.*,
    CASE
      WHEN c.card_cents IS NOT NULL
       AND (c.public_candidate IS NULL OR c.card_cents < c.public_candidate)
      THEN c.card_cents
      ELSE c.public_candidate
    END AS effective_cents,
    CASE
      WHEN c.card_cents IS NOT NULL
       AND (c.public_candidate IS NULL OR c.card_cents < c.public_candidate)
      THEN 'card'
      WHEN c.public_candidate IS NOT NULL THEN 'public'
      ELSE NULL
    END AS price_access
  FROM candidates c
), sequenced AS (
  SELECT e.*,
    LAG(e.id) OVER w AS previous_price_observation_id,
    LAG(e.effective_cents) OVER w AS previous_effective_cents,
    LAG(e.price_access) OVER w AS previous_price_access,
    LAG(e.seller_id) OVER w AS previous_seller_id,
    LAG(e.in_stock) OVER w AS previous_in_stock,
    MIN(e.effective_cents) OVER (
      PARTITION BY e.product_id
      ORDER BY e.observed_at, e.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_historical_low_cents
  FROM effective e
  WINDOW w AS (PARTITION BY e.product_id ORDER BY e.observed_at, e.id)
)
SELECT s.*,
  CASE WHEN s.in_stock = 1
         AND s.effective_cents IS NOT NULL
         AND s.previous_effective_cents IS NOT NULL
         AND s.effective_cents < s.previous_effective_cents
       THEN 1 ELSE 0 END AS is_price_drop,
  CASE WHEN s.in_stock = 1
         AND s.effective_cents IS NOT NULL
         AND s.prior_historical_low_cents IS NOT NULL
         AND s.effective_cents < s.prior_historical_low_cents
       THEN 1 ELSE 0 END AS is_historical_low,
  CASE WHEN s.previous_price_observation_id IS NOT NULL
         AND s.seller_id IS NOT s.previous_seller_id
       THEN 1 ELSE 0 END AS seller_changed
FROM sequenced s;

CREATE VIEW latest_product_sightings AS
SELECT s.*
FROM (
  SELECT ps.*,
         ROW_NUMBER() OVER (
           PARTITION BY ps.product_id ORDER BY ps.seen_at DESC, ps.id DESC
         ) AS rn
  FROM product_sightings ps
) s
WHERE s.rn = 1;

CREATE VIEW current_price_drops AS
SELECT m.*, s.seen_at AS last_sighted_at, s.coverage_id
FROM (
  SELECT pom.*,
         ROW_NUMBER() OVER (
           PARTITION BY pom.product_id ORDER BY pom.observed_at DESC, pom.id DESC
         ) AS rn
  FROM price_observation_movements pom
) m
JOIN latest_product_sightings s
  ON s.product_id = m.product_id
 AND s.price_observation_id = m.id
WHERE m.rn = 1 AND m.is_price_drop = 1;
