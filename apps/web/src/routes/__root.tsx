/// <reference types="vite/client" />
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Scrapito — ofertas Ripley & Falabella Perú" },
    ],
  }),
  notFoundComponent: () => (
    <RootDocument>
      <main style={{ padding: 24 }}>
        <h1>404</h1>
        <p>Página no encontrada.</p>
        <Link to="/offers">Ver ofertas</Link>
      </main>
    </RootDocument>
  ),
  errorComponent: ({ error }) => (
    <RootDocument>
      <main style={{ padding: 24 }}>
        <h1>Algo salió mal</h1>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
      </main>
    </RootDocument>
  ),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="es-PE">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav style={{ display: "flex", gap: 16, padding: "12px 24px", borderBottom: "1px solid #e2e2e2" }}>
          <Link to="/offers">Ofertas</Link>
          <Link to="/updates">Actualizaciones</Link>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
