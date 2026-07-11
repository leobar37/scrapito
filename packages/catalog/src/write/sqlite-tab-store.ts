import type { Database } from "bun:sqlite";

/** Structurally identical to @scrapito/ingest's TabRegistryStore; kept local
 * so catalog never imports from an app. */
export interface TabRegistryStore {
  upsert(session: string, tab: { tabId: string; label?: string; url: string; purpose?: string }): void;
  remove(session: string, tabId: string): void;
  clearSession(session: string): void;
}

export class SqliteTabStore implements TabRegistryStore {
  constructor(private readonly db: Database) {}

  upsert(session: string, tab: { tabId: string; label?: string; url: string; purpose?: string }): void {
    this.db
      .query(
        `INSERT INTO browser_tabs (session, tab_id, label, url, purpose, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(session, tab_id) DO UPDATE SET
           label=excluded.label, url=excluded.url, purpose=excluded.purpose, updated_at=excluded.updated_at`,
      )
      .run(session, tab.tabId, tab.label ?? null, tab.url, tab.purpose ?? null, new Date().toISOString());
  }

  remove(session: string, tabId: string): void {
    this.db.query("DELETE FROM browser_tabs WHERE session=? AND tab_id=?").run(session, tabId);
  }

  clearSession(session: string): void {
    this.db.query("DELETE FROM browser_tabs WHERE session=?").run(session);
  }
}
