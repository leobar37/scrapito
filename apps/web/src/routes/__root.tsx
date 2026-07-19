/// <reference types="vite/client" />
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import "../app.css";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Scrapito — ofertas Ripley, Falabella & Promart Perú" },
    ],
    links: [
      { rel: "icon", href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛒</text></svg>" },
    ],
  }),
  notFoundComponent: () => (
    <RootDocument>
      <main className="max-w-4xl mx-auto px-6 py-12 text-center">
        <h1 className="text-4xl font-bold text-gray-800 mb-4">404</h1>
        <p className="text-gray-500 mb-6">Página no encontrada.</p>
        <Link to="/offers" className="text-indigo-600 hover:text-indigo-800 font-medium">Ver ofertas</Link>
      </main>
    </RootDocument>
  ),
  errorComponent: ({ error }) => (
    <RootDocument>
      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-red-600 mb-4">Algo salió mal</h1>
        <pre className="text-sm text-gray-500 bg-gray-50 p-4 rounded-lg overflow-auto">{error instanceof Error ? error.message : String(error)}</pre>
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
      <body className="bg-gray-50 text-gray-900 antialiased min-h-screen">
        <header className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-gray-200">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
            <Link to="/offers" className="flex items-center gap-2 font-bold text-lg text-indigo-700 hover:text-indigo-900 transition-colors">
              <span className="text-2xl">🛒</span>
              <span>Scrapito</span>
            </Link>
            <div className="flex items-center gap-6 text-sm font-medium">
              <Link to="/offers" className="text-gray-600 hover:text-gray-900 transition-colors" activeProps={{ className: "text-indigo-700" }}>
                Ofertas
              </Link>
              <Link to="/updates" className="text-gray-600 hover:text-gray-900 transition-colors" activeProps={{ className: "text-indigo-700" }}>
                Actualizaciones
              </Link>
            </div>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
