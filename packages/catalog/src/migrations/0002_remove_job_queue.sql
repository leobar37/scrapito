-- 0002_remove_job_queue.sql — ingestion becomes a synchronous CLI: drop the job
-- queue entirely, make scraper_runs audit-only (no job_id), track images
-- downloaded per run, and add the single-writer lease table.

PRAGMA foreign_keys = OFF;

CREATE TABLE scraper_runs_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  scraper_id         TEXT NOT NULL,
  store_id           TEXT NOT NULL REFERENCES stores(id),
  status             TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  products_saved     INTEGER NOT NULL DEFAULT 0,
  products_rejected  INTEGER NOT NULL DEFAULT 0,
  requests_made      INTEGER NOT NULL DEFAULT 0,
  images_downloaded  INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT
);

INSERT INTO scraper_runs_new
  (id, scraper_id, store_id, status, started_at, finished_at,
   products_saved, products_rejected, requests_made, images_downloaded, last_error)
SELECT id, scraper_id, store_id, status, started_at, finished_at,
       products_saved, products_rejected, requests_made, 0, last_error
FROM scraper_runs;

DROP TABLE scraper_runs;
ALTER TABLE scraper_runs_new RENAME TO scraper_runs;

CREATE TABLE scraper_run_events_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES scraper_runs(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  data_json  TEXT
);

INSERT INTO scraper_run_events_new (id, run_id, at, level, message, data_json)
SELECT id, run_id, at, level, message, data_json FROM scraper_run_events;

DROP TABLE scraper_run_events;
ALTER TABLE scraper_run_events_new RENAME TO scraper_run_events;

DROP TABLE scrape_jobs;

-- Single-writer lease: the ingestion CLI holds row name='catalog-ingest' while
-- it runs, refreshing the TTL every ~10s; a non-expired lease blocks a second
-- concurrent ingestion process (WRITER_LOCKED).
CREATE TABLE writer_leases (
  name         TEXT PRIMARY KEY,
  token        TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

PRAGMA foreign_keys = ON;
