-- 0008_retention_and_activity.sql — explicit retention audit and activity-aware
-- current offer/drop views. Price observations remain append-only and intact.

CREATE TABLE retention_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id    TEXT NOT NULL UNIQUE,
  request_json     TEXT NOT NULL,
  dry_run          INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  started_at       TEXT NOT NULL,
  finished_at      TEXT NOT NULL,
  candidates       INTEGER NOT NULL CHECK (candidates >= 0),
  sightings_deleted INTEGER NOT NULL CHECK (sightings_deleted >= 0),
  has_more         INTEGER NOT NULL CHECK (has_more IN (0, 1)),
  result_json      TEXT NOT NULL
);
CREATE INDEX idx_retention_runs_finished ON retention_runs(finished_at DESC, id DESC);

DROP VIEW current_price_drops;
DROP VIEW current_offers;

-- Legacy products without target membership remain visible. Once membership
-- evidence exists, a product is current while at least one membership is active.
CREATE VIEW current_offers AS
WITH computed AS (
  SELECT l.*, COALESCE(l.offer_cents, l.regular_cents) AS public_candidate
  FROM latest_product_prices l
), effective AS (
  SELECT c.*,
    CASE
      WHEN c.card_cents IS NOT NULL
       AND (c.public_candidate IS NULL OR c.card_cents < c.public_candidate)
      THEN c.card_cents ELSE c.public_candidate
    END AS effective_cents,
    CASE
      WHEN c.card_cents IS NOT NULL
       AND (c.public_candidate IS NULL OR c.card_cents < c.public_candidate)
      THEN 'card' ELSE 'public'
    END AS price_access
  FROM computed c
)
SELECT
  pr.id AS product_id,
  pr.store_id,
  pr.external_id,
  pr.name,
  pr.brand,
  pr.seller_name,
  pr.canonical_url,
  pr.last_seen_at,
  e.observed_at AS latest_price_observed_at,
  e.regular_cents,
  e.offer_cents,
  e.card_cents,
  e.in_stock,
  e.effective_cents,
  e.price_access,
  CASE
    WHEN e.regular_cents IS NOT NULL AND e.regular_cents > 0 AND e.effective_cents < e.regular_cents
    THEN 'verified_discount' ELSE 'promotional_price'
  END AS quality,
  CASE
    WHEN e.regular_cents IS NOT NULL AND e.regular_cents > 0 AND e.effective_cents < e.regular_cents
    THEN e.regular_cents - e.effective_cents ELSE NULL
  END AS discount_cents,
  CASE
    WHEN e.regular_cents IS NOT NULL AND e.regular_cents > 0 AND e.effective_cents < e.regular_cents
    THEN CAST((e.regular_cents - e.effective_cents) * 10000 / e.regular_cents AS INTEGER)
    ELSE NULL
  END AS discount_bps
FROM products pr
JOIN effective e ON e.product_id = pr.id
WHERE (e.offer_cents IS NOT NULL OR e.card_cents IS NOT NULL)
  AND (
    NOT EXISTS (
      SELECT 1 FROM target_product_memberships m WHERE m.product_id = pr.id
    )
    OR EXISTS (
      SELECT 1 FROM target_product_memberships m
       WHERE m.product_id = pr.id AND m.inactive_at IS NULL
    )
  );

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
WHERE m.rn = 1 AND m.is_price_drop = 1
  AND (
    NOT EXISTS (
      SELECT 1 FROM target_product_memberships tm WHERE tm.product_id = m.product_id
    )
    OR EXISTS (
      SELECT 1 FROM target_product_memberships tm
       WHERE tm.product_id = m.product_id AND tm.inactive_at IS NULL
    )
  );
