/** Public types for the browser management layer. */

export interface TabInfo {
  id: string;
  label?: string;
  url: string;
  active: boolean;
}

export type TabPurpose = "discovery" | "recipe";

export interface StartOptions {
  session: string;
  restoreKey?: string;
  headless?: boolean;
  userAgent?: string;
  browserArgs?: string[];
}

export interface TabOptions {
  url?: string;
  reuse?: boolean;
  purpose?: TabPurpose;
}

export interface GotoOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

export interface NetworkFilter {
  urlPattern?: string;
  resourceType?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
}

export interface AccessibilitySnapshot {
  tree: unknown;
}

/** Persistence hook so the tab registry survives crashes for inspection. */
export interface TabRegistryStore {
  upsert(session: string, tab: { tabId: string; label?: string; url: string; purpose?: string }): void;
  remove(session: string, tabId: string): void;
  clearSession(session: string): void;
}

export const noopTabStore: TabRegistryStore = {
  upsert: () => {},
  remove: () => {},
  clearSession: () => {},
};
