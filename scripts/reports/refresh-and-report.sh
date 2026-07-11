#!/usr/bin/env bash
#
# Job periódico: (opcional) refresca datos de tecnología y luego genera el
# reporte de mejores ofertas. Pensado para cron / systemd timer.
#
#   REFRESH=1 ./scripts/reports/refresh-and-report.sh --min-discount-bps 2000
#
# - Sin REFRESH=1 solo lee la BD y genera el reporte (rápido, sin red).
# - Con REFRESH=1 corre la ingesta primero; requiere SCRAP_USER_AGENT honesto
#   y el browser instalado (bun run browser:install). Respeta el single-writer:
#   no lances dos refrescos a la vez.
set -euo pipefail

# Ir a la raíz del repo (este script vive en scripts/reports/).
cd "$(dirname "$0")/../.."

if [ "${REFRESH:-0}" = "1" ]; then
  : "${SCRAP_USER_AGENT:?exporta SCRAP_USER_AGENT para poder scrapear}"
  for store in ripley-pe falabella-pe; do
    echo "[refresh] $store ..."
    # --category tecnologia: ajusta a la categoría real de cada tienda.
    bun run ingest -- run "$store" --category tecnologia --pages 1-3 --json || \
      echo "[refresh] $store falló; continúo con datos existentes"
  done
fi

# Genera el reporte (solo lectura). Todos los flags extra se pasan tal cual.
exec bun run scripts/reports/tech-deals.ts "$@"
