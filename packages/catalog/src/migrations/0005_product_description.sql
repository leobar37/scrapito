-- 0005_product_description.sql — add a nullable free-text description column to
-- products, populated from detail-page scrapes. Specs/attributes continue to
-- live in attributes_json; this is the long-form copy shown on the detail page.

ALTER TABLE products ADD COLUMN description TEXT;
