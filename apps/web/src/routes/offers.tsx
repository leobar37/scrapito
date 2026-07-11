import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { decodeOfferSearchParams, type OfferSearchInput } from "@scrapito/contracts";
import { offersInfiniteQueryOptions } from "../features/offers/api/queries.ts";
import { OfferCard } from "../features/offers/components/OfferCard.tsx";

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
    <main style={{ padding: 24 }}>
      <h1>No se pudo cargar la búsqueda</h1>
      <p>{error instanceof Error ? error.message : "Filtros de URL inválidos."}</p>
      <button type="button" onClick={() => reset()}>
        Reintentar
      </button>
    </main>
  ),
});

function OffersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const query = useInfiniteQuery(offersInfiniteQueryOptions(search as OfferSearchInput));

  const allOffers = query.data?.pages.flatMap((p) => p.data) ?? [];
  const facets = query.data?.pages[0]?.facets;

  function updateSearch(patch: Partial<OfferSearchInput>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch, cursor: undefined }) as never });
  }

  return (
    <main style={{ padding: 24, display: "grid", gridTemplateColumns: "220px 1fr", gap: 24 }}>
      <aside>
        <h2>Filtros</h2>
        <label>
          Buscar
          <input
            defaultValue={search.q ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") updateSearch({ q: (e.target as HTMLInputElement).value || undefined });
            }}
          />
        </label>
        <div>
          <label>
            <input
              type="checkbox"
              checked={search.inStock !== false}
              onChange={(e) => updateSearch({ inStock: e.target.checked })}
            />
            Solo en stock
          </label>
        </div>
        <label>
          Orden
          <select value={search.sort ?? "discount_desc"} onChange={(e) => updateSearch({ sort: e.target.value as OfferSearchInput["sort"] })}>
            <option value="discount_desc">Mayor descuento</option>
            <option value="price_asc">Precio: menor a mayor</option>
            <option value="price_desc">Precio: mayor a menor</option>
            <option value="updated_desc">Actualizado recientemente</option>
            {search.q ? <option value="relevance">Relevancia</option> : null}
          </select>
        </label>
        {facets ? (
          <div>
            <h3>Tiendas</h3>
            {facets.stores.map((s) => (
              <div key={s.value}>
                {s.value} ({s.count})
              </div>
            ))}
            <h3>Marcas</h3>
            {facets.brands.slice(0, 10).map((b) => (
              <div key={b.value}>
                {b.value} ({b.count})
              </div>
            ))}
          </div>
        ) : null}
      </aside>

      <section>
        {query.isPending ? <p>Cargando ofertas…</p> : null}
        {query.isError ? (
          <div>
            <p>Error al cargar ofertas: {(query.error as Error).message}</p>
            <button type="button" onClick={() => query.refetch()}>
              Reintentar
            </button>
          </div>
        ) : null}
        {!query.isPending && !query.isError && allOffers.length === 0 ? <p>No se encontraron ofertas.</p> : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
          {allOffers.map((offer) => (
            <OfferCard key={offer.id} offer={offer} />
          ))}
        </div>

        {query.hasNextPage ? (
          <button type="button" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Cargando…" : "Cargar más"}
          </button>
        ) : null}
      </section>
    </main>
  );
}
