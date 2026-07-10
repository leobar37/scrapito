/**
 * Falabella Peru normalizers. Listing SSR exposes products at
 * props.pageProps.results; detail pages expose the same product schema plus
 * JSON-LD. Prices arrive as typed arrays of formatted strings.
 */
import type { ProductInput } from "../../domain/schemas.ts";
import { extractNextData, findJsonLdByType } from "../../util/html-extract.ts";
import { canonicalizeFalabellaImage } from "../image-url.ts";
import { toCents } from "../money.ts";
import { asArray, asBoolean, asRecord, asString, dig } from "../parse-helpers.ts";

const STORE = "falabella-pe" as const;
const BASE = "https://www.falabella.com.pe";

function canonicalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, BASE).toString();
  } catch {
    return undefined;
  }
}

/** Extract a cents value for a given Falabella price `type` from the prices array. */
function priceByType(prices: unknown, types: string[]): number | null {
  for (const entry of asArray(prices)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const type = asString(rec["type"]) ?? "";
    if (!types.some((t) => type.toLowerCase().includes(t.toLowerCase()))) continue;
    const raw = rec["price"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const cents = toCents(value);
    if (cents != null) return cents;
  }
  return null;
}

function falabellaImages(value: unknown): { url: string; position: number }[] {
  const out: { url: string; position: number }[] = [];
  asArray(value).forEach((entry, i) => {
    const url = typeof entry === "string" ? entry : asString(asRecord(entry)?.["url"]);
    if (!url) return;
    const canon = canonicalizeFalabellaImage(url);
    if (canon) out.push({ url: canon, position: out.length });
  });
  return out;
}

function normalizeFalabellaItem(raw: unknown): ProductInput | null {
  const p = asRecord(raw);
  if (!p) return null;
  const externalId = asString(p["skuId"]) ?? asString(p["productId"]) ?? asString(p["id"]);
  const name = asString(p["displayName"]) ?? asString(p["name"]);
  const url = canonicalUrl(asString(p["url"]));
  if (!externalId || !name || !url) return null;

  const prices = p["prices"];
  const regularCents = priceByType(prices, ["normal"]);
  const offerCents = priceByType(prices, ["event", "internet", "offer"]);
  const cardCents = priceByType(prices, ["cmr", "card"]);
  if (regularCents == null && offerCents == null && cardCents == null) return null;

  return {
    store: STORE,
    externalId,
    canonicalUrl: url,
    name,
    brand: asString(p["brand"]) ?? null,
    sellerId: asString(p["sellerId"]) ?? null,
    sellerName: asString(p["sellerName"]) ?? asString(p["seller"]) ?? null,
    sponsored: asBoolean(p["isSponsored"]) || asBoolean(p["sponsored"]),
    attributes: {},
    categories: [],
    images: falabellaImages(p["mediaUrls"] ?? p["images"]),
    price: {
      regularCents,
      offerCents,
      cardCents,
      currency: "PEN",
      inStock: p["isAvailable"] !== false && p["inStock"] !== false,
      sellerId: asString(p["sellerId"]) ?? null,
    },
  };
}

/** Normalize a Falabella listing page from its HTML (via __NEXT_DATA__). */
export function normalizeFalabellaList(html: string): {
  products: ProductInput[];
  rejected: number;
  ok: boolean;
} {
  const data = extractNextData(html);
  const results = dig(data, "props.pageProps.results");
  if (!Array.isArray(results)) {
    return { products: [], rejected: 0, ok: false };
  }
  const out: ProductInput[] = [];
  let rejected = 0;
  for (const item of results) {
    const norm = normalizeFalabellaItem(item);
    if (norm) out.push(norm);
    else rejected++;
  }
  return { products: out, rejected, ok: true };
}

/** Normalize a Falabella product-detail page (SSR product first, JSON-LD fallback). */
export function normalizeFalabellaDetail(html: string, sourceUrl: string): ProductInput | null {
  const data = extractNextData(html);
  const product = dig(data, "props.pageProps.product") ?? dig(data, "props.pageProps.results.0");
  const fromSsr = normalizeFalabellaItem(product);
  if (fromSsr) return { ...fromSsr, canonicalUrl: canonicalUrl(sourceUrl) ?? fromSsr.canonicalUrl };

  const node = findJsonLdByType(html, "Product");
  if (!node) return null;
  const name = asString(node["name"]);
  const externalId = asString(node["sku"]) ?? asString(node["mpn"]);
  const canon = canonicalUrl(sourceUrl);
  if (!name || !externalId || !canon) return null;
  const offers = asRecord(node["offers"]) ?? asRecord(asArray(node["offers"])[0]) ?? {};
  const price = toCents(offers["price"]);
  if (price == null) return null;
  const brandRec = asRecord(node["brand"]);
  return {
    store: STORE,
    externalId,
    canonicalUrl: canon,
    name,
    brand: brandRec ? asString(brandRec["name"]) ?? null : asString(node["brand"]) ?? null,
    sellerId: null,
    sellerName: null,
    sponsored: false,
    attributes: {},
    categories: [],
    images: [],
    price: { offerCents: price, currency: "PEN", inStock: true, sellerId: null },
  };
}
