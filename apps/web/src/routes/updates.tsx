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

function UpdatesPage() {
  const updates = useQuery(updatesQueryOptions());
  const freshness = useQuery(freshnessQueryOptions());

  return (
    <main style={{ padding: 24 }}>
      <h1>Actualizaciones</h1>
      <p style={{ opacity: 0.7 }}>
        Vista de solo lectura. Las ejecuciones de ingesta las dispara un agente externo con{" "}
        <code>scrap-ingest run … --json</code>; esta página nunca inicia, cancela ni reintenta una ejecución.
      </p>

      <h2>Frescura por tienda</h2>
      {freshness.isPending ? <p>Cargando…</p> : null}
      {freshness.isError ? <p>Error al cargar frescura.</p> : null}
      <table>
        <thead>
          <tr>
            <th>Tienda</th>
            <th>Última ejecución exitosa</th>
            <th>Antigüedad (s)</th>
          </tr>
        </thead>
        <tbody>
          {freshness.data?.data.map((f) => (
            <tr key={f.storeId}>
              <td>{f.storeId}</td>
              <td>{f.lastSuccessfulAt ?? "—"}</td>
              <td>{f.ageSeconds ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Historial de ejecuciones</h2>
      {updates.isPending ? <p>Cargando…</p> : null}
      {updates.isError ? <p>Error al cargar historial.</p> : null}
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Scraper</th>
            <th>Tienda</th>
            <th>Estado</th>
            <th>Guardados</th>
            <th>Rechazados</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {updates.data?.data.map((u) => (
            <tr key={u.runId}>
              <td>{u.runId}</td>
              <td>{u.scraperId}</td>
              <td>{u.storeId}</td>
              <td>{u.status}</td>
              <td>{u.productsSaved}</td>
              <td>{u.productsRejected}</td>
              <td>{u.error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
