/**
 * Promart Peru VTEX API normalizers. The catalog system search API at
 * /api/catalog_system/pub/products/search/… returns a JSON array of VTEX
 * product objects. Each product may contain multiple items (SKUs).
 *
 * Prices: ListPrice (regular) and Price (offer) are in soles (e.g. 559 = S/559.00).
 * Tarjeta Oh! teasers use PaymentMethodId "203" (or paymentSystemId 203).
 */
import type { ProductInput, VariantInput } from "@scrapito/contracts";
import { canonicalizePromartImage } from "../image-url.ts";
import { toCents } from "../money.ts";
import { asArray, asBoolean, asRecord, asString, dig } from "../parse-helpers.ts";

const STORE = "promart-pe" as const;

function vtexImages(items: unknown): { url: string; position: number }[] {
  const images: { url: string; position: number }[] = [];
  let idx = 0;
  for (const item of asArray(items)) {
    const rec = asRecord(item);
    if (!rec) continue;
    const url = canonicalizePromartImage(asString(rec["imageUrl"]) ?? "");
    if (url) {
      images.push({ url, position: idx++ });
    }
  }
  return images;
}

/** Extract cardCents from Tarjeta Oh! teasers (PaymentMethodId 203).
 *  Returns null if no matching teaser found. */
function extractCardCents(teasers: unknown): number | null {
  for (const t of asArray(teasers)) {
    const rec = asRecord(t);
    if (!rec) continue;
    const paymentMethodId = asString(rec["PaymentMethodId"]) ?? asString(rec["paymentMethodId"]);
    if (paymentMethodId !== "203") continue;
    // Try effects first (common VTEX teaser pattern)
    const effects = asArray(rec["Effects"] ?? rec["effects"]);
    for (const eff of effects) {
      const e = asRecord(eff);
      if (!e) continue;
      const cents = toCents(e["Value"] ?? e["value"]);
      if (cents != null && cents > 0) return cents;
    }
    // Fallback: direct discount value
    const discount = toCents(rec["Discount"] ?? rec["discount"] ?? rec["Value"] ?? rec["value"]);
    if (discount != null && discount > 0) return discount;
  }
  return null;
}

/** Collect flat string-valued attributes from the VTEX product object
 *  that aren't part of the known structured fields. */
function collectAttributes(raw: Record<string, unknown>): Record<string, unknown> {
  const known: Record<string, true> = {
    productId: true, productName: true, link: true, description: true, brand: true,
    categories: true, categoriesIds: true, items: true, Marca: true,
    productReference: true, linkText: true, productTitle: true, metaTagDescription: true,
    releaseDate: true, clusterHighlights: true, searchableClusters: true,
    allSpecifications: true, allSpecificationsGroups: true,
    skus: true, departmentId: true, categoryId: true, brandId: true, brandImageUrl: true,
  };
  const attrs: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (known[key]) continue;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      attrs[key] = val;
    }
  }
  return attrs;
}

/** Normalize a single VTEX product object into a ProductInput. */
export function normalizeVtexProduct(raw: unknown): ProductInput | null {
  const p = asRecord(raw);
  if (!p) return null;

  const externalId = asString(p["productId"]);
  const name = asString(p["productName"]);
  const canonicalUrl = asString(p["link"]);
  if (!externalId || !name || !canonicalUrl) return null;

  const items = asArray(p["items"]);
  if (items.length === 0) return null;
  const firstItem = asRecord(items[0]);
  if (!firstItem) return null;

  const sellers = asArray(firstItem["sellers"]);
  if (sellers.length === 0) return null;
  const firstSeller = asRecord(sellers[0]);
  if (!firstSeller) return null;

  const offer = asRecord(firstSeller["commertialOffer"]);
  if (!offer) return null;

  const regularCents = toCents(offer["ListPrice"]);
  const offerCents = toCents(offer["Price"]);
  const cardCents = extractCardCents(offer["Teasers"] ?? offer["teasers"]);
  if (regularCents == null && offerCents == null && cardCents == null) return null;

  // Categories paired by index
  const catNames = asArray(p["categories"]);
  const catIds = asArray(p["categoriesIds"]);
  const categories: { externalId: string; name: string; url: string }[] = [];
  for (let i = 0; i < Math.min(catNames.length, catIds.length); i++) {
    const catId = asString(catIds[i])?.replace(/\//g, "") ?? "";
    const catName = asString(catNames[i])?.replace(/\//g, "").trim();
    if (catId && catName) {
      categories.push({
        externalId: catId,
        name: catName,
        url: `https://www.promart.pe${asString(catNames[i])}`,
      });
    }
  }

  // Variants from items (multiple SKUs: colors/sizes)
  const variants: VariantInput[] = [];
  const variantsObserved = items.length > 1;
  for (const it of items) {
    const item = asRecord(it);
    if (!item) continue;
    const itemSellers = asArray(item["sellers"]);
    const itemOffer = itemSellers.length > 0
      ? asRecord((asRecord(itemSellers[0]) ?? {})["commertialOffer"])
      : null;
    variants.push({
      externalId: asString(item["itemId"]) ?? "",
      sku: asString(item["ean"]) ?? asString(item["itemId"]) ?? null,
      name: asString(item["name"]) ?? null,
      colorName: null,
      colorHex: null,
      size: null,
      inStock: itemOffer ? (asBoolean(itemOffer["IsAvailable"]) || itemOffer["IsAvailable"] === undefined) : false,
      attributes: {},
      images: vtexImages(item["images"]),
    });
  }

  return {
    store: STORE,
    externalId,
    canonicalUrl,
    name,
    sponsored: asBoolean(p["isSponsored"]) || asBoolean(p["sponsored"]) || false,
    description: asString(p["description"]) ?? null,
    brand: asString(p["brand"]) ?? asString(dig(p, "Marca[0]")) ?? null,
    sellerId: asString(firstSeller["sellerId"]) ?? null,
    sellerName: asString(firstSeller["sellerName"]) ?? null,
    categories,
    images: vtexImages(firstItem["images"]),
    variants,
    variantsObserved,
    attributes: collectAttributes(p),
    price: {
      regularCents,
      offerCents,
      cardCents,
      currency: "PEN",
      inStock: offer["IsAvailable"] !== false,
      sellerId: asString(firstSeller["sellerId"]) ?? null,
      raw: offer as Record<string, unknown>,
    },
  };
}

/** Normalize a VTEX search API JSON response (an array of product objects). */
export function normalizeVtexSearchResults(json: unknown): { products: ProductInput[]; ok: boolean } {
  const arr = asArray(json);
  const products: ProductInput[] = [];
  for (const el of arr) {
    const product = normalizeVtexProduct(el);
    if (product) products.push(product);
  }
  return { products, ok: products.length > 0 };
}
