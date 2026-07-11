import { useMemo, useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { offerHistoryQueryOptions, productDetailQueryOptions } from "../features/offers/api/queries.ts";
import { resolveImageUrl } from "../lib/api-client.ts";
import { ApiRequestError } from "../lib/api-client.ts";

export const Route = createFileRoute("/products/$productId")({
  loader: async ({ context, params }) => {
    const id = Number(params.productId);
    if (!Number.isInteger(id)) throw notFound();
    try {
      await context.queryClient.ensureQueryData(productDetailQueryOptions(id));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) throw notFound();
      throw err;
    }
    await context.queryClient.ensureQueryData(offerHistoryQueryOptions(id));
  },
  component: ProductDetailPage,
  errorComponent: ({ error, reset }) => (
    <main style={{ padding: 24 }}>
      <h1>No se pudo cargar el producto</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onClick={() => reset()}>
        Reintentar
      </button>
    </main>
  ),
});

function centsToSoles(cents: number): string {
  return (cents / 100).toLocaleString("es-PE", { style: "currency", currency: "PEN" });
}

function ProductDetailPage() {
  const { productId } = Route.useParams();
  const id = Number(productId);
  const productQuery = useQuery(productDetailQueryOptions(id));
  const historyQuery = useQuery(offerHistoryQueryOptions(id));
  const [activeVariantId, setActiveVariantId] = useState<number | null>(null);

  const product = productQuery.data?.data;
  const activeVariant = useMemo(
    () => product?.variants.find((v) => v.id === activeVariantId) ?? null,
    [product, activeVariantId],
  );
  const gallery = activeVariant && activeVariant.images.length > 0 ? activeVariant.images : product?.images ?? [];

  if (productQuery.isPending) return <main style={{ padding: 24 }}>Cargando producto…</main>;
  if (productQuery.isError) {
    return (
      <main style={{ padding: 24 }}>
        <p>Error: {(productQuery.error as Error).message}</p>
        <button type="button" onClick={() => productQuery.refetch()}>
          Reintentar
        </button>
      </main>
    );
  }
  if (!product) return <main style={{ padding: 24 }}>Producto no encontrado.</main>;

  return (
    <main style={{ padding: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
      <div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {gallery.length > 0 ? (
            gallery.map((img) => (
              <img
                key={img.sha256 + img.position}
                src={resolveImageUrl(img.url) ?? undefined}
                alt={product.name}
                style={{ width: 120, height: 120, objectFit: "contain", border: "1px solid #eee" }}
              />
            ))
          ) : (
            <div style={{ width: 240, height: 240, background: "#f2f2f2" }} />
          )}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {product.storeId} {product.brand ? `· ${product.brand}` : ""}
        </div>
        <h1>{product.name}</h1>
        <div style={{ fontSize: 24, fontWeight: 700 }}>
          {product.offerCents != null ? centsToSoles(product.offerCents) : centsToSoles(product.regularCents ?? 0)}
        </div>
        {product.regularCents != null && product.offerCents != null && product.regularCents !== product.offerCents ? (
          <div style={{ textDecoration: "line-through", opacity: 0.5 }}>{centsToSoles(product.regularCents)}</div>
        ) : null}
        <div>{product.inStock ? "En stock" : "Agotado"}</div>

        {product.variants.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <h3>Variantes</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {product.variants.map((v) => (
                <button
                  type="button"
                  key={v.id}
                  onClick={() => setActiveVariantId(v.id)}
                  style={{
                    padding: "6px 10px",
                    border: v.id === activeVariantId ? "2px solid #333" : "1px solid #ccc",
                    borderRadius: 6,
                    background: v.colorHex ?? "transparent",
                  }}
                >
                  {[v.colorName, v.size].filter(Boolean).join(" / ") || v.sku || v.externalId}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 24 }}>
          <h3>Historial de precios</h3>
          {historyQuery.isPending ? <p>Cargando historial…</p> : null}
          {historyQuery.isError ? <p>No se pudo cargar el historial.</p> : null}
          {historyQuery.data ? (
            <>
              <p>
                Mínimo histórico (público):{" "}
                {historyQuery.data.data.publicHistoricalLowCents != null
                  ? centsToSoles(historyQuery.data.data.publicHistoricalLowCents)
                  : "—"}
              </p>
              <p>
                Mínimo histórico (tarjeta):{" "}
                {historyQuery.data.data.cardHistoricalLowCents != null
                  ? centsToSoles(historyQuery.data.data.cardHistoricalLowCents)
                  : "—"}
              </p>
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
