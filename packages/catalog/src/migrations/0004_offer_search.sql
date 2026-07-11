-- 0004_offer_search.sql — offer derivation views (mirrors deriveOffer() in
-- @scrapito/contracts) plus indexes backing set-based offer search/pagination.

CREATE VIEW latest_product_prices AS
SELECT po.*
FROM (
  SELECT
    p.*,
    ROW_NUMBER() OVER (PARTITION BY p.product_id ORDER BY p.observed_at DESC, p.id DESC) AS rn
  FROM price_observations p
) po
WHERE po.rn = 1;

-- current_offers: one row per product with a promotional/card price, with the
-- effective price, access channel, quality, and discount computed at query
-- time. A product with neither offer_cents nor card_cents is not an offer and
-- is excluded entirely.
CREATE VIEW current_offers AS
WITH computed AS (
  SELECT
    l.*,
    COALESCE(l.offer_cents, l.regular_cents) AS public_candidate
  FROM latest_product_prices l
),
effective AS (
  SELECT
    c.*,
    CASE
      WHEN c.card_cents IS NOT NULL AND (c.public_candidate IS NULL OR c.card_cents < c.public_candidate)
      THEN c.card_cents
      ELSE c.public_candidate
    END AS effective_cents,
    CASE
      WHEN c.card_cents IS NOT NULL AND (c.public_candidate IS NULL OR c.card_cents < c.public_candidate)
      THEN 'card'
      ELSE 'public'
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
    THEN 'verified_discount'
    ELSE 'promotional_price'
  END AS quality,
  CASE
    WHEN e.regular_cents IS NOT NULL AND e.regular_cents > 0 AND e.effective_cents < e.regular_cents
    THEN e.regular_cents - e.effective_cents
    ELSE NULL
  END AS discount_cents,
  CASE
    WHEN e.regular_cents IS NOT NULL AND e.regular_cents > 0 AND e.effective_cents < e.regular_cents
    THEN CAST((e.regular_cents - e.effective_cents) * 10000 / e.regular_cents AS INTEGER)
    ELSE NULL
  END AS discount_bps
FROM products pr
JOIN effective e ON e.product_id = pr.id
WHERE e.offer_cents IS NOT NULL OR e.card_cents IS NOT NULL;

CREATE INDEX idx_price_observations_product_latest ON price_observations(product_id, observed_at DESC, id DESC);
CREATE INDEX idx_products_store_brand ON products(store_id, brand);
CREATE INDEX idx_product_categories_category_product ON product_categories(category_id, product_id);
