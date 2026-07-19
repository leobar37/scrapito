-- 0009_product_sighting_identity_snapshot.sql — immutable product identity
-- metadata captured at sighting time for exact historical handoffs.
--
-- Columns remain nullable so the additive migration is safe for existing rows.
-- Existing sightings deliberately stay unversioned: current product metadata
-- cannot be backfilled as historical fact. Read-side handoff rejects any
-- coverage containing an unversioned sighting instead of silently fabricating
-- exactness. All new CatalogStore sightings write version 1 snapshots.

ALTER TABLE product_sightings ADD COLUMN name_snapshot TEXT;
ALTER TABLE product_sightings ADD COLUMN brand_snapshot TEXT;
ALTER TABLE product_sightings ADD COLUMN canonical_url_snapshot TEXT;
ALTER TABLE product_sightings ADD COLUMN seller_id_snapshot TEXT;
ALTER TABLE product_sightings ADD COLUMN seller_name_snapshot TEXT;
ALTER TABLE product_sightings ADD COLUMN identity_snapshot_version INTEGER
  CHECK (identity_snapshot_version IS NULL OR identity_snapshot_version = 1);
