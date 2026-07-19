-- Insert promart-pe store row so FK constraints pass.
INSERT OR IGNORE INTO stores(id, name, base_url)
VALUES ('promart-pe', 'Promart Peru', 'https://www.promart.pe');
