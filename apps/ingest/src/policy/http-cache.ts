/**
 * HTTP metadata cache used for conditional requests (If-None-Match /
 * If-Modified-Since) and freshness floors. The persistent SQLite implementation
 * lives in the persistence layer; tests use the in-memory store here.
 */
export interface HttpCacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
  status: number;
  fetchedAt: number;
  /** Absolute epoch ms before which the resource is considered fresh. */
  freshUntil: number;
}

export interface HttpCacheStore {
  get(url: string): HttpCacheEntry | undefined;
  set(entry: HttpCacheEntry): void;
}

export class MemoryHttpCache implements HttpCacheStore {
  private readonly map = new Map<string, HttpCacheEntry>();
  get(url: string): HttpCacheEntry | undefined {
    return this.map.get(url);
  }
  set(entry: HttpCacheEntry): void {
    this.map.set(entry.url, entry);
  }
}
