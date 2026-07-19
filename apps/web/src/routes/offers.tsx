import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { decodeOfferSearchParams, type OfferSearchInput } from "@scrapito/contracts";
import { offersInfiniteQueryOptions } from "../features/offers/api/queries.ts";
import { OfferCard, OfferCardSkeleton } from "../features/offers/components/OfferCard.tsx";
import { useState } from "react";

function toURLSearchParams(raw: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }
  return params;
}

export const Route = createFileRoute("/offers")({
  validateSearch: (raw: Record<string, unknown>): Partial<OfferSearchInput> => decodeOfferSearchParams(toURLSearchParams(raw)),
  loaderDeps: ({ search }) => ({ search: search as OfferSearchInput }),
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureInfiniteQueryData(offersInfiniteQueryOptions(deps.search));
  },
  component: OffersPage,
  errorComponent: ({ error, reset }) => (
    <main className="max-w-4xl mx-auto px-6 py-12 text-center">
      <h1 className="text-2xl font-bold text-gray-800 mb-4">No se pudo cargar la búsqueda</h1>
      <p className="text-gray-500 mb-6">{error instanceof Error ? error.message : "Filtros de URL inválidos."}</p>
      <button type="button" onClick={() => reset()} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
        Reintentar
      </button>
    </main>
  ),
});

function OffersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const query = useInfiniteQuery(offersInfiniteQueryOptions(search as OfferSearchInput));
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const allOffers = query.data?.pages.flatMap((p) => p.data) ?? [];
  const facets = query.data?.pages[0]?.facets;

  function updateSearch(patch: Partial<OfferSearchInput>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch, cursor: undefined }) as never });
  }

  function toggleFilter(key: "stores" | "brands" | "quality" | "priceAccess", value: string) {
    const current = ((search as Record<string, unknown>)[key] as string[] | undefined) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    updateSearch({ [key]: next.length > 0 ? next : undefined } as Partial<OfferSearchInput>);
  }

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      {/* Search bar */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            defaultValue={search.q ?? ""}
            placeholder="Buscar productos..."
            onKeyDown={(e) => {
              if (e.key === "Enter") updateSearch({ q: (e.target as HTMLInputElement).value || undefined });
            }}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <select
          value={search.sort ?? "discount_desc"}
          onChange={(e) => updateSearch({ sort: e.target.value as OfferSearchInput["sort"] })}
          className="bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="discount_desc">Mayor descuento</option>
          <option value="price_asc">Precio: menor a mayor</option>
          <option value="price_desc">Precio: mayor a menor</option>
          <option value="updated_desc">Más recientes</option>
          {search.q ? <option value="relevance">Relevancia</option> : null}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={search.inStock !== false}
            onChange={(e) => updateSearch({ inStock: e.target.checked })}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          En stock
        </label>

        <button
          type="button"
          onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}
          className="lg:hidden px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
        >
          Filtros
        </button>
      </div>

      <div className="flex gap-6">
        {/* Sidebar filters */}
        <aside className={`${mobileFiltersOpen ? "block" : "hidden"} lg:block w-56 shrink-0 space-y-5`}>
          {facets ? (
            <>
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tiendas</h3>
                <div className="space-y-1">
                  {facets.stores.map((s) => (
                    <label key={s.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(search.stores ?? []).includes(s.value)}
                        onChange={() => toggleFilter("stores", s.value)}
                        className="rounded border-gray-300 text-indigo-600"
                      />
                      <span className="flex-1">{s.value}</span>
                      <span className="text-xs text-gray-400">{s.count}</span>
                    </label>
                  ))}
                </div>
              </div>

              {facets.brands.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Marcas</h3>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {facets.brands.slice(0, 15).map((b) => (
                      <label key={b.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                        type="checkbox"
                        checked={(search.brands ?? []).includes(b.value)}
                        onChange={() => toggleFilter("brands", b.value)}
                        className="rounded border-gray-300 text-indigo-600"
                      />
                        <span className="flex-1 truncate">{b.value}</span>
                        <span className="text-xs text-gray-400">{b.count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Calidad</h3>
                <div className="space-y-1">
                  {facets.quality.map((q) => (
                    <label key={q.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(search.quality ?? []).includes(q.value)}
                        onChange={() => toggleFilter("quality", q.value)}
                        className="rounded border-gray-300 text-indigo-600"
                      />
                      <span className="flex-1">{q.value === "verified_discount" ? "Descuento verificado" : "Precio promocional"}</span>
                      <span className="text-xs text-gray-400">{q.count}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </aside>

        {/* Product grid */}
        <section className="flex-1 min-w-0">
          {query.isPending && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array.from({ length: 12 }).map((_, i) => <OfferCardSkeleton key={i} />)}
            </div>
          )}

          {query.isError && (
            <div className="text-center py-12">
              <p className="text-red-500 mb-4">Error al cargar ofertas: {(query.error as Error).message}</p>
              <button type="button" onClick={() => query.refetch()} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
                Reintentar
              </button>
            </div>
          )}

          {!query.isPending && !query.isError && allOffers.length === 0 && (
            <div className="text-center py-16">
              <div className="text-5xl mb-4">🔍</div>
              <p className="text-gray-500 text-lg">No se encontraron ofertas.</p>
              <p className="text-gray-400 text-sm mt-1">Intenta ajustar los filtros o el término de búsqueda.</p>
            </div>
          )}

          {allOffers.length > 0 && (
            <>
              <p className="text-sm text-gray-400 mb-4">
                {allOffers.length} producto{allOffers.length !== 1 ? "s" : ""}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {allOffers.map((offer) => (
                  <OfferCard key={offer.id} offer={offer} />
                ))}
              </div>
            </>
          )}

          {query.hasNextPage && (
            <div className="text-center mt-8">
              <button
                type="button"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="px-8 py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-xl font-medium hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50 transition-all"
              >
                {query.isFetchingNextPage ? "Cargando más..." : "Cargar más productos"}
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
