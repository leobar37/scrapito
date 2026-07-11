import { Link } from "@tanstack/react-router";
import type { OfferSummary } from "@scrapito/contracts";
import { resolveImageUrl } from "../../../lib/api-client.ts";

function centsToSoles(cents: number): string {
  return (cents / 100).toLocaleString("es-PE", { style: "currency", currency: "PEN" });
}

export function OfferCard({ offer }: { offer: OfferSummary }) {
  const image = resolveImageUrl(offer.imageUrl);
  return (
    <Link
      to="/products/$productId"
      params={{ productId: String(offer.id) }}
      style={{
        display: "block",
        border: "1px solid #e2e2e2",
        borderRadius: 8,
        padding: 12,
        textDecoration: "none",
        color: "inherit",
      }}
    >
      {image ? (
        <img src={image} alt={offer.name} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "contain" }} />
      ) : (
        <div style={{ width: "100%", aspectRatio: "1 / 1", background: "#f2f2f2" }} />
      )}
      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
        {offer.storeId} {offer.brand ? `· ${offer.brand}` : ""}
      </div>
      <div style={{ fontWeight: 600, margin: "4px 0" }}>{offer.name}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 18, fontWeight: 700 }}>{centsToSoles(offer.effectiveCents)}</span>
        {offer.regularCents != null && offer.regularCents !== offer.effectiveCents ? (
          <span style={{ textDecoration: "line-through", opacity: 0.5, fontSize: 13 }}>
            {centsToSoles(offer.regularCents)}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, marginTop: 4 }}>
        {offer.priceAccess === "card" ? <span>precio con tarjeta</span> : null}
        {offer.quality === "verified_discount" && offer.discountBps != null ? (
          <span style={{ color: "#0a7a2e", fontWeight: 600, marginLeft: offer.priceAccess === "card" ? 6 : 0 }}>
            -{Math.round(offer.discountBps / 100)}%
          </span>
        ) : offer.quality === "promotional_price" ? (
          <span style={{ color: "#a15c00", marginLeft: offer.priceAccess === "card" ? 6 : 0 }}>precio promocional</span>
        ) : null}
      </div>
      {!offer.inStock ? <div style={{ fontSize: 12, color: "#b00020", marginTop: 4 }}>Agotado</div> : null}
      <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
        Actualizado {new Date(offer.latestPriceObservedAt).toLocaleDateString("es-PE")}
      </div>
    </Link>
  );
}
