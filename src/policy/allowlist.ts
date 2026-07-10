/**
 * Static host allowlist and hard-coded safety-floor path exclusions. These are
 * enforced regardless of live robots rules.
 */

/** Storefront document hosts. */
export const STOREFRONT_HOSTS: Record<string, true> = {
  "simple.ripley.com.pe": true,
  "www.falabella.com.pe": true,
};

/** Image CDN hosts. */
export const IMAGE_HOSTS: Record<string, true> = {
  "rimage.ripley.com.pe": true,
  "media.falabella.com": true,
  "media.falabella.com.pe": true,
};

/** Every allowlisted host. */
export const ALLOWED_HOSTS: Record<string, true> = {
  ...STOREFRONT_HOSTS,
  ...IMAGE_HOSTS,
};

/** Explicitly forbidden legacy domain (robots disallow-all). Never target. */
export const FORBIDDEN_HOSTS: Record<string, true> = {
  "www.ripley.com.pe": true,
};

/** Safety-floor path prefixes/globs that must never be crawled, per host. */
const SAFETY_FLOOR: Record<string, RegExp[]> = {
  "simple.ripley.com.pe": [
    /^\/escribe-tu-review/i,
    /^\/api\/v2\/recommendations\//i,
    /^\/api\/v2\/sponsored-recommendations\//i,
    /^\/marketingcomponent\/api\//i,
    /\/product_test_/i,
  ],
  "www.falabella.com.pe": [
    /^\/cgi-bin\//i,
    /^\/falabella-pe\/basket/i,
    /^\/falabella-pe\/myaccount/i,
    /^\/falabella-pe\/checkout/i,
    /^\/falabella-pe\/orders/i,
  ],
};

export function isHostAllowed(host: string): boolean {
  return ALLOWED_HOSTS[host] === true;
}

export function isStorefrontHost(host: string): boolean {
  return STOREFRONT_HOSTS[host] === true;
}

export function isImageHost(host: string): boolean {
  return IMAGE_HOSTS[host] === true;
}

/** True when the path is excluded by the hard-coded safety floor for its host. */
export function isSafetyFloorBlocked(host: string, pathname: string): boolean {
  const rules = SAFETY_FLOOR[host];
  if (!rules) return false;
  return rules.some((re) => re.test(pathname));
}

/** Reject private / loopback / link-local IP literal targets. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  // IPv6 loopback / link-local.
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
