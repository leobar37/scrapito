/**
 * Store-specific image URL canonicalization to a single archival rendition.
 * These rules were verified during investigation:
 *  - Falabella `.../w=1500,h=1500,fit=pad` -> `.../public`; `/public` unchanged.
 *  - Ripley legacy listing URLs ending in `.` -> append `webp`; complete
 *    `.jpeg` JSON-LD URLs are unchanged.
 * Falabella CMS/marketing assets from `images.falabella.com` are ignored.
 */

/** Canonicalize a Falabella media URL to its `/public` archival form. */
export function canonicalizeFalabellaImage(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  // Ignore CMS/marketing assets.
  if (u.hostname === "images.falabella.com") return null;
  if (u.hostname !== "media.falabella.com" && u.hostname !== "media.falabella.com.pe") {
    return null;
  }
  // Replace a trailing transform segment (e.g. `w=1500,h=1500,fit=pad`) with `public`.
  const segments = u.pathname.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last === "public") return u.toString();
  if (/[=,]/.test(last)) {
    segments[segments.length - 1] = "public";
    u.pathname = segments.join("/");
    return u.toString();
  }
  // No recognizable transform; append /public.
  if (!u.pathname.endsWith("/public")) {
    u.pathname = u.pathname.replace(/\/?$/, "/public");
  }
  return u.toString();
}

/** Canonicalize a Ripley image URL, appending `webp` to legacy dot-terminated URLs. */
export function canonicalizeRipleyImage(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  if (u.hostname !== "rimage.ripley.com.pe") return null;
  if (u.pathname.endsWith(".")) {
    u.pathname = u.pathname + "webp";
  }
  return u.toString();
}
/** Canonicalize a Promart VTEX image URL by stripping sizing segments from the path.
 *  E.g. /arquivos/ids/8761837-1000-1000/148753.jpg → /arquivos/ids/8761837/148753.jpg
 *  Plain /arquivos/ids/NNNNNNN/filename.jpg is already canonical and passes through. */
export function canonicalizePromartImage(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  if (u.hostname !== "promart.vteximg.com.br") return null;
  // Strip -WIDTH-HEIGHT from the ID segment: /arquivos/ids/8761837-1000-1000/... → /arquivos/ids/8761837/...
  u.pathname = u.pathname.replace(/\/ids\/(\d+)-\d+-\d+\//, "/ids/$1/");
  return u.toString();
}


/** Parse a URL or return null (inference avoids URL global-type clashes). */
function safeUrl(url: string) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
