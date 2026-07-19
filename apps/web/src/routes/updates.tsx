import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { freshnessQueryOptions, updatesQueryOptions } from "../features/offers/api/queries.ts";

export const Route = createFileRoute("/updates")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(updatesQueryOptions()),
      context.queryClient.ensureQueryData(freshnessQueryOptions()),
    ]);
  },
  component: UpdatesPage,
});

const statusColors: Record<string, string> = {
  completed: "bg-green-100 text-green-700",
  partial: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  running: "bg-blue-100 text-blue-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function UpdatesPage() {
  const updates = useQuery(updatesQueryOptions());
  const freshness = useQuery(freshnessQueryOptions());

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Actualizaciones</h1>
      <p className="text-sm text-gray-500 mb-8">
        Vista de solo lectura. Las ejecuciones las dispara un agente externo con{" "}
        <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">scrap-ingest run ... --json</code>.
      </p>

      {/* Freshness cards */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Frescura por tienda</h2>
        {freshness.isPending && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-xl p-5 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
                <div className="h-3 bg-gray-200 rounded w-2/3" />
              </div>
            ))}
          </div>
        )}
        {freshness.isError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
            Error al cargar frescura.
          </div>
        )}
        {freshness.data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {freshness.data.data.map((f) => (
              <div key={f.storeId} className="bg-white border border-gray-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-gray-900 uppercase text-sm">{f.storeId}</h3>
                  {f.lastSuccessfulAt ? (
                    <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-medium">Activo</span>
                  ) : (
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Sin datos</span>
                  )}
                </div>
                {f.lastSuccessfulAt ? (
                  <p className="text-sm text-gray-500">
                    Última ejecución: {new Date(f.lastSuccessfulAt).toLocaleString("es-PE")}
                  </p>
                ) : (
                  <p className="text-sm text-gray-400">Sin ejecuciones exitosas</p>
                )}
                {f.ageSeconds != null && (
                  <p className="text-xs text-gray-400 mt-1">
                    Hace {Math.floor(f.ageSeconds / 60)} minutos
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Runs history table */}
      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Historial de ejecuciones</h2>
        {updates.isPending && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden animate-pulse">
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-8 bg-gray-100 rounded" />
              ))}
            </div>
          </div>
        )}
        {updates.isError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
            Error al cargar historial.
          </div>
        )}
        {updates.data && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Run</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Scraper</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Tienda</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Estado</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Guardados</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Imágenes</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {updates.data.data.map((u) => (
                    <tr key={u.runId} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">#{u.runId}</td>
                      <td className="px-4 py-3 text-gray-700">{u.scraperId}</td>
                      <td className="px-4 py-3 text-gray-500 uppercase text-xs">{u.storeId}</td>
                      <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                      <td className="px-4 py-3 text-right text-gray-700">{u.productsSaved}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{u.imagesDownloaded}</td>
                      <td className="px-4 py-3 text-xs text-red-500 max-w-[200px] truncate">{u.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
