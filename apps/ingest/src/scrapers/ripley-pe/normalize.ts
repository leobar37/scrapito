/**
 * Ripley Peru normalizers.
 *  - List: SSR `__NEXT_DATA__` at props.pageProps.findabilityProps.data.products.
 *  - Detail: schema.org Product JSON-LD first; `__NEXT_DATA__` only for variants
 *    genuinely absent from JSON-LD.
 * Sponsored and organic results normalize to the same schema.
 */
import type { ProductInput } from "@scrapito/contracts";
import { extractNextData, findJsonLdByType } from "../../util/html-extract.ts";
import { canonicalizeRipleyImage } from "../image-url.ts";
import { toCents } from "../money.ts";
import { asArray, asBoolean, asRecord, asString, dig } from "../parse-helpers.ts";

const STORE = "ripley-pe" as const;
const BASE = "https://simple.ripley.com.pe";

function canonicalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, BASE).toString();
  } catch {
    return undefined;
  }
}

function ripleyImages(value: unknown): { url: string; position: number }[] {
  const out: { url: string; position: number }[] = [];
  asArray(value).forEach((entry, i) => {
    const url = typeof entry === "string" ? entry : asString(asRecord(entry)?.["url"]);
    if (!url) return;
    const canon = canonicalizeRipleyImage(url);
    if (canon) out.push({ url: canon, position: i });
  });
  return out;
}

/** Turn a product name into a Ripley URL slug (lowercase, accent-stripped). */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalize a single Ripley list product record. Returns null if unusable.
 * Supports the live SSR shape (sku, price/oldPrice/priceNumber, no url) and the
 * older documented shape (partNumber, prices.*, url) for backward compatibility. */
function normalizeRipleyListItem(raw: unknown): ProductInput | null {
  const p = asRecord(raw);
  if (!p) return null;
  const externalId = asString(p["sku"]) ?? asString(p["partNumber"]) ?? asString(p["id"]);
  const name = asString(p["name"]);
  if (!externalId || !name) return null;

  // URL: explicit `url` (older shape) else build slug + parentProductID (live shape).
  const parentId = asString(p["parentProductID"]);
  const url = asString(p["url"])
    ? canonicalUrl(asString(p["url"]))
    : parentId
      ? `${BASE}/${slugify(name)}-${parentId}`
      : undefined;
  if (!url) return null;

  // Price: prices.* object (older) else flat price/oldPrice/priceNumber (live).
  const prices = asRecord(p["prices"]);
  let regularCents: number | null;
  let offerCents: number | null;
  let cardCents: number | null;
  if (prices) {
    regularCents = toCents(prices["listPrice"] ?? prices["normalPrice"]);
    offerCents = toCents(prices["offerPrice"] ?? prices["internetPrice"]);
    cardCents = toCents(prices["cardPrice"] ?? prices["ripleyPrice"]);
  } else {
    offerCents = toCents(p["priceNumber"] ?? p["price"]);
    regularCents = toCents(p["oldPrice"]);
    cardCents = null;
  }
  if (regularCents == null && offerCents == null && cardCents == null) return null;

  // Seller: live shape nests shop{}, older shape has flat sellerId/sellerName.
  const shop = asRecord(p["shop"]);
  const sellerId =
    asString(p["sellerId"]) ?? (shop ? asString(shop["sellerId"]) : undefined) ?? null;
  const sellerName =
    asString(p["sellerName"]) ??
    (shop ? asString(shop["shopName"]) : undefined) ??
    asString(p["seller"]) ??
    null;

  // Sponsored: boolean (older) or nested sponsored{ is_sponsored } (live).
  const sponsoredRec = asRecord(p["sponsored"]);
  const sponsored = asBoolean(p["isSponsored"]) || asBoolean(sponsoredRec?.["is_sponsored"]);

  return {
    store: STORE,
    externalId,
    canonicalUrl: url,
    name,
    brand: asString(p["brand"]) ?? null,
    sellerId,
    sellerName,
    sponsored,
    attributes: {},
    categories: [],
    images: ripleyImages(p["images"]),
    variants: [],
    variantsObserved: false,
    price: {
      regularCents,
      offerCents,
      cardCents,
      currency: "PEN",
      inStock: p["inStock"] !== false,
      sellerId,
    },
  };
}

/** Normalize a Ripley listing page from its HTML (via __NEXT_DATA__). */
export function normalizeRipleyList(html: string): {
  products: ProductInput[];
  rejected: number;
  ok: boolean;
} {
  const data = extractNextData(html);
  const products = dig(data, "props.pageProps.findabilityProps.data.products");
  const list = asArray(products);
  if (!Array.isArray(products)) {
    return { products: [], rejected: 0, ok: false };
  }
  const out: ProductInput[] = [];
  let rejected = 0;
  for (const item of list) {
    const norm = normalizeRipleyListItem(item);
    if (norm) out.push(norm);
    else rejected++;
  }
  return { products: out, rejected, ok: true };
}

/** Normalize a Ripley product-detail page (JSON-LD Product first). */
export function normalizeRipleyDetail(html: string, sourceUrl: string): ProductInput | null {
  const node = findJsonLdByType(html, "Product");
  if (!node) return null;
  const name = asString(node["name"]);
  const externalId = asString(node["sku"]) ?? asString(node["mpn"]);
  if (!name || !externalId) return null;

  const brandRec = asRecord(node["brand"]);
  const brand = brandRec ? asString(brandRec["name"]) : asString(node["brand"]);

  const offers = asRecord(node["offers"]) ?? asRecord(asArray(node["offers"])[0]) ?? {};
  const price = toCents(offers["price"]);
  const currency = asString(offers["priceCurrency"]) ?? "PEN";
  const availability = asString(offers["availability"]) ?? "";
  const sellerRec = asRecord(offers["seller"]);

  const imagesRaw = node["image"];
  const imageList = typeof imagesRaw === "string" ? [imagesRaw] : asArray(imagesRaw);
  const images: { url: string; position: number }[] = [];
  imageList.forEach((entry, i) => {
    const url = asString(entry);
    if (!url) return;
    const canon = canonicalizeRipleyImage(url);
    if (canon) images.push({ url: canon, position: i });
  });

  const canon = canonicalUrl(sourceUrl);
  if (!canon || currency !== "PEN" || price == null) return null;

  return {
    store: STORE,
    externalId,
    canonicalUrl: canon,
    name,
    brand: brand ?? null,
    sellerId: null,
    sellerName: sellerRec ? asString(sellerRec["name"]) ?? null : null,
    sponsored: false,
    attributes: {},
    categories: [],
    images,
    variants: [],
    variantsObserved: false,
    price: {
      offerCents: price,
      currency: "PEN",
      inStock: /InStock/i.test(availability) || availability === "",
      sellerId: null,
    },
  };
}

/**
 * Map one Ripley SSR `variants[]` entry to a raw VariantInput candidate,
 * joining `colors[]` by `sku`. Each candidate is validated independently by
 * `validateVariants` (see @scrapito/contracts) — a malformed entry here never
 * rejects the parent product.
 */
function ripleyVariantImages(variant: Record<string, unknown>): { url: string; position: number }[] {
  const explicit = ripleyImages(variant["images"]);
  if (explicit.length > 0) return explicit;
  const primary = asString(variant["primaryImage"]);
  if (!primary) return [];
  const canon = canonicalizeRipleyImage(primary);
  return canon ? [{ url: canon, position: 0 }] : [];
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** Extract variants[]/colors[] from a Ripley SSR product record. Returns
 * `observed: false` (never fabricates) unless a genuine, non-empty
 * `variants[]` array is present. */
function ripleyVariants(product: Record<string, unknown>): { variants: unknown[]; observed: boolean } {
  const rawVariants = asArray(product["variants"]);
  if (rawVariants.length === 0) return { variants: [], observed: false };

  const colorBySku = new Map<string, Record<string, unknown>>();
  for (const entry of asArray(product["colors"])) {
    const rec = asRecord(entry);
    const sku = rec ? asString(rec["sku"]) : undefined;
    if (sku && rec) colorBySku.set(sku, rec);
  }

  const variants = rawVariants
    .map((raw) => {
      const v = asRecord(raw);
      const sku = v ? asString(v["sku"]) : undefined;
      if (!v || !sku) return null;
      const color = colorBySku.get(sku);
      const rawHex = color ? asString(color["hex"]) ?? asString(color["colorHex"]) : undefined;
      return {
        externalId: sku,
        sku,
        name: asString(v["name"]) ?? null,
        colorName: color ? asString(color["name"]) ?? null : null,
        colorHex: rawHex && HEX_COLOR.test(rawHex) ? rawHex : null,
        size: asString(v["size"]) ?? null,
        inStock: v["inStock"] !== false,
        attributes: {},
        images: ripleyVariantImages(v),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return { variants, observed: variants.length > 0 };
}

/**
 * Normalize a Ripley product-detail page from `__NEXT_DATA__` when it carries
 * the full product record (variants/colors) — used only when JSON-LD lacks
 * variants. `variantsObserved` is true ONLY when a genuine non-empty
 * `variants[]` was present in the SSR payload; an incomplete/absent variant
 * array yields `variantsObserved:false, variants:[]` rather than guessing.
 */
export function normalizeRipleyDetailNextData(html: string, sourceUrl: string): ProductInput | null {
  const data = extractNextData(html);
  const product =
    asRecord(dig(data, "props.pageProps.product")) ??
    asRecord(dig(data, "props.pageProps.productDetail")) ??
    asRecord(dig(data, "props.pageProps.findabilityProps.data.product"));
  if (!product) return null;

  const externalId = asString(product["sku"]) ?? asString(product["partNumber"]);
  const name = asString(product["name"]);
  const canon = canonicalUrl(sourceUrl);
  if (!externalId || !name || !canon) return null;

  const prices = asRecord(product["prices"]);
  const regularCents = prices ? toCents(prices["listPrice"] ?? prices["normalPrice"]) : toCents(product["oldPrice"]);
  const offerCents = prices
    ? toCents(prices["offerPrice"] ?? prices["internetPrice"])
    : toCents(product["priceNumber"] ?? product["price"]);
  const cardCents = prices ? toCents(prices["cardPrice"] ?? prices["ripleyPrice"]) : null;
  if (regularCents == null && offerCents == null && cardCents == null) return null;

  const { variants, observed } = ripleyVariants(product);

  return {
    store: STORE,
    externalId,
    canonicalUrl: canon,
    name,
    brand: asString(product["brand"]) ?? null,
    sellerId: null,
    sellerName: null,
    sponsored: false,
    attributes: {},
    categories: [],
    images: ripleyImages(product["images"]),
    variants,
    variantsObserved: observed,
    price: {
      regularCents,
      offerCents,
      cardCents,
      currency: "PEN",
      inStock: product["inStock"] !== false,
      sellerId: null,
    },
  };
}
