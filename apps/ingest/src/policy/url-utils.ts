/** Known campaign/tracking query parameters stripped during canonicalization. */
const TRACKING_PARAMS: Record<string, true> = {
  utm_source: true,
  utm_medium: true,
  utm_campaign: true,
  utm_term: true,
  utm_content: true,
  utm_id: true,
  gclid: true,
  fbclid: true,
  mkt_tok: true,
  ref: true,
  referrer: true,
  s_kwcid: true,
  msclkid: true,
};

/**
 * Canonicalize a URL for deduplication: lowercase host, strip tracking params,
 * drop the fragment, and sort remaining query params for stable comparison.
 */
export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAMS[k]) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}
