import { useMemo, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
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
    <main className="max-w-4xl mx-auto px-6 py-12 text-center">
      <h1 className="text-2xl font-bold text-gray-800 mb-4">No se pudo cargar el producto</h1>
      <p className="text-gray-500 mb-6">{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onClick={() => reset()} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
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
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [activeVariantId, setActiveVariantId] = useState<number | null>(null);

  const product = productQuery.data?.data;
  const activeVariant = useMemo(
    () => product?.variants.find((v) => v.id === activeVariantId) ?? null,
    [product, activeVariantId],
  );
  const gallery = activeVariant && activeVariant.images.length > 0 ? activeVariant.images : product?.images ?? [];
  const currentImage = gallery[activeImageIdx];

  if (productQuery.isPending) {
    return (
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 animate-pulse">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="aspect-square bg-gray-200 rounded-2xl" />
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/4" />
            <div className="h-8 bg-gray-200 rounded w-3/4" />
            <div className="h-6 bg-gray-200 rounded w-1/2" />
            <div className="h-6 bg-gray-200 rounded w-1/3" />
          </div>
        </div>
      </main>
    );
  }

  if (productQuery.isError) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-12 text-center">
        <p className="text-red-500 mb-4">Error: {(productQuery.error as Error).message}</p>
        <button type="button" onClick={() => productQuery.refetch()} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
          Reintentar
        </button>
      </main>
    );
  }

  if (!product) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-12 text-center">
        <p className="text-gray-500 text-lg">Producto no encontrado.</p>
        <Link to="/offers" className="text-indigo-600 hover:text-indigo-800 font-medium mt-4 inline-block">Volver a ofertas</Link>
      </main>
    );
  }

  const hasDiscount = product.regularCents != null && product.offerCents != null && product.regularCents > product.offerCents;

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <Link to="/offers" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Volver a ofertas
      </Link>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Image gallery */}
        <div>
          <div className="aspect-square bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4">
            {currentImage ? (
              <img
                src={resolveImageUrl(currentImage.url) ?? undefined}
                alt={product.name}
                className="w-full h-full object-contain p-4"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-200 text-6xl">📷</div>
            )}
          </div>
          {gallery.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {gallery.map((img, idx) => (
                <button
                  key={img.sha256 + img.position}
                  type="button"
                  onClick={() => setActiveImageIdx(idx)}
                  className={`shrink-0 w-16 h-16 rounded-lg border-2 overflow-hidden transition-all ${
                    idx === activeImageIdx ? "border-indigo-500 ring-2 ring-indigo-200" : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <img src={resolveImageUrl(img.url) ?? undefined} alt="" className="w-full h-full object-contain p-1" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Product info */}
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-400 mb-2">
            <span className="uppercase tracking-wide font-medium">{product.storeId}</span>
            {product.brand && (
              <>
                <span>·</span>
                <span className="text-gray-500">{product.brand}</span>
              </>
            )}
          </div>

          <h1 className="text-2xl font-bold text-gray-900 mb-4 leading-tight">{product.name}</h1>

          <div className="bg-gray-50 rounded-xl p-5 mb-6">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold text-gray-900">
                {centsToSoles(product.offerCents ?? product.regularCents ?? 0)}
              </span>
              {hasDiscount && (
                <span className="text-lg text-gray-400 line-through">{centsToSoles(product.regularCents!)}</span>
              )}
            </div>
            {hasDiscount && product.regularCents != null && product.offerCents != null && (
              <div className="flex items-center gap-2 mt-2">
                <span className="bg-green-100 text-green-700 text-sm font-semibold px-2.5 py-1 rounded-full">
                  -{Math.round(((product.regularCents - product.offerCents) / product.regularCents) * 100)}%
                </span>
                <span className="text-sm text-green-600">Ahorras {centsToSoles(product.regularCents - product.offerCents)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mb-6">
            {product.inStock ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                En stock
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700 bg-red-50 px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 bg-red-500 rounded-full" />
                Agotado
              </span>
            )}
            {product.sellerName && (
              <span className="text-sm text-gray-500">Vendido por {product.sellerName}</span>
            )}
          </div>

          {product.variants.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Variantes</h3>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((v) => (
                  <button
                    type="button"
                    key={v.id}
                    onClick={() => { setActiveVariantId(v.id); setActiveImageIdx(0); }}
                    className={`px-3 py-2 rounded-lg text-sm border transition-all ${
                      v.id === activeVariantId
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 ring-2 ring-indigo-200"
                        : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                    }`}
                  >
                    {[v.colorName, v.size].filter(Boolean).join(" / ") || v.sku || v.externalId}
                  </button>
                ))}
              </div>
            </div>
          )}

          {product.description && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Descripción</h3>
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{product.description}</p>
            </div>
          )}

          {Object.keys(product.attributes).length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Especificaciones</h3>
              <dl className="border border-gray-200 rounded-lg overflow-hidden divide-y divide-gray-100">
                {Object.entries(product.attributes).map(([key, value]) => (
                  <div key={key} className="flex gap-4 px-3 py-2 text-sm even:bg-gray-50">
                    <dt className="w-1/3 text-gray-500">{key}</dt>
                    <dd className="flex-1 text-gray-800">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Historial de precios</h3>
            {historyQuery.isPending && <p className="text-sm text-gray-400">Cargando historial...</p>}
            {historyQuery.isError && <p className="text-sm text-red-500">No se pudo cargar el historial.</p>}
            {historyQuery.data && (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Mínimo histórico público</p>
                  <p className="text-lg font-bold text-gray-900">
                    {historyQuery.data.data.publicHistoricalLowCents != null
                      ? centsToSoles(historyQuery.data.data.publicHistoricalLowCents)
                      : "Sin datos"}
                  </p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Mínimo histórico tarjeta</p>
                  <p className="text-lg font-bold text-gray-900">
                    {historyQuery.data.data.cardHistoricalLowCents != null
                      ? centsToSoles(historyQuery.data.data.cardHistoricalLowCents)
                      : "Sin datos"}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
