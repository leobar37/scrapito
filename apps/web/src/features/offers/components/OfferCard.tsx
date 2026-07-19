import { Link } from "@tanstack/react-router";
import type { OfferSummary } from "@scrapito/contracts";
import { resolveImageUrl } from "../../../lib/api-client.ts";

function centsToSoles(cents: number): string {
  return (cents / 100).toLocaleString("es-PE", { style: "currency", currency: "PEN" });
}

export function OfferCard({ offer }: { offer: OfferSummary }) {
  const image = resolveImageUrl(offer.imageUrl);
  const hasDiscount = offer.quality === "verified_discount" && offer.discountBps != null;
  const discountPercent = offer.discountBps != null ? Math.round(offer.discountBps / 100) : null;
  const showOriginal = offer.regularCents != null && offer.regularCents !== offer.effectiveCents;

  return (
    <Link
      to="/products/$productId"
      params={{ productId: String(offer.id) }}
      className="group block bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md hover:border-gray-300 transition-all duration-200"
    >
      <div className="relative aspect-square bg-gray-100 overflow-hidden">
        {image ? (
          <img
            src={image}
            alt={offer.name}
            loading="lazy"
            className="w-full h-full object-contain p-3 group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-4xl">📷</div>
        )}
        {!offer.inStock && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <span className="bg-white text-red-600 font-semibold text-sm px-3 py-1 rounded-full">Agotado</span>
          </div>
        )}
        {hasDiscount && discountPercent != null && discountPercent >= 15 && offer.inStock && (
          <div className="absolute top-2 left-2 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full shadow">
            -{discountPercent}%
          </div>
        )}
      </div>

      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className="uppercase tracking-wide font-medium">{offer.storeId}</span>
          {offer.brand && (
            <>
              <span>·</span>
              <span className="text-gray-500 truncate">{offer.brand}</span>
            </>
          )}
        </div>

        <h3 className="text-sm font-medium text-gray-800 line-clamp-2 leading-snug min-h-[2.5em]">
          {offer.name}
        </h3>

        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-lg font-bold text-gray-900">{centsToSoles(offer.effectiveCents)}</span>
          {showOriginal && (
            <span className="text-xs text-gray-400 line-through">{centsToSoles(offer.regularCents!)}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          {offer.priceAccess === "card" && (
            <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">tarjeta</span>
          )}
          {hasDiscount && discountPercent != null && (
            <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">-{discountPercent}%</span>
          )}
          {offer.quality === "promotional_price" && (
            <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">promo</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function OfferCardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden animate-pulse">
      <div className="aspect-square bg-gray-200" />
      <div className="p-3 space-y-2">
        <div className="h-3 bg-gray-200 rounded w-1/3" />
        <div className="h-4 bg-gray-200 rounded w-full" />
        <div className="h-4 bg-gray-200 rounded w-2/3" />
        <div className="h-5 bg-gray-200 rounded w-1/2" />
      </div>
    </div>
  );
}
