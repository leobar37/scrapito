-- Insert oechsle-pe store row so FK constraints pass.
INSERT OR IGNORE INTO stores(id, name, base_url)
VALUES ('oechsle-pe', 'Oechsle Peru', 'https://www.oechsle.pe');
