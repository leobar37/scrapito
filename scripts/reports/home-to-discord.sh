#!/usr/bin/env bash
#
# Job diario "home → Discord":
#  1. Refresca las categorías activas de las 3 tiendas (single-writer).
#  2. Empuja el top 1 verified_discount por tienda al canal Discord configurado
#     vía `hermes send` (gateway ya conectado, no requiere webhook manual).
#
# REFRESH=1  ./scripts/reports/home-to-discord.sh
#
# Variables de entorno:
#   REFRESH=1                 corre los scrapers antes del reporte (default: 0)
#   SCRAP_USER_AGENT          UA honesto para scrapear (obligatorio si REFRESH=1)
#   DISCORD_TARGET            target para `hermes send` (default: el canal scrapito)
#                             formato: discord:SERVER_ID:CHANNEL_ID
#   SCRAP_DB_PATH             ruta a la BD (default: data/scrap.sqlite)
#
# No lances dos en paralelo: respeta el writer lease de `scrap-ingest run`.
set -euo pipefail

cd "$(dirname "$0")/../.."

export SCRAP_DB_PATH="${SCRAP_DB_PATH:-$(pwd)/data/scrap.sqlite}"
export DISCORD_TARGET="${DISCORD_TARGET:-discord:1105884928043925545:1528202928312287293}"

if [ "${REFRESH:-0}" = "1" ]; then
  : "${SCRAP_USER_AGENT:?exporta SCRAP_USER_AGENT para scrapear}"
  for cmd in \
    "ripley-pe-products --category tecnologia --pages 1" \
    "falabella-pe-products --search tecnologia --pages 1" \
    "promart-pe-products --search refrigeracion --pages 1"; do
    set -- $cmd
    scraper="$1"; shift
    echo "[home-to-discord] refresh $* $scraper ..."
    bun run ingest -- run "$scraper" "$@" --no-images --json \
      || echo "[home-to-discord] $scraper falló; continúo con datos existentes"
  done
fi

echo "[home-to-discord] generando reporte..." >&2
REPORT_JSON=$(SCRAP_DB_PATH="$SCRAP_DB_PATH" bun run apps/ingest/src/cli/index.ts reports discord-top-deals --dry-run 2>/dev/null | tr -d '\n')
if [ -z "$REPORT_JSON" ]; then
  echo "[home-to-discord] no se pudo generar el reporte" >&2
  exit 1
fi

# Parsea el JSON via stdin (evita problemas con args demasiado largos).
MESSAGE=$(printf '%s' "$REPORT_JSON" | bun -e '
const raw = await Bun.stdin.text();
let env;
try { env = JSON.parse(raw); } catch (e) { console.error("parse:", e.message); process.exit(2); }
const r = env.report;
const lines = ["📊 **Mejores ofertas por tienda**"];
if (!r || !r.stores || r.stores.length === 0) {
  lines.push("Sin ofertas verificadas en este momento.");
} else {
  for (const s of r.stores) {
    const pct = Math.round((s.discountBps || 0) / 100);
    const eff = (s.effectiveCents / 100).toFixed(2);
    const reg = (s.regularCents / 100).toFixed(2);
    const name = s.name.length > 110 ? s.name.slice(0, 109) + "…" : s.name;
    lines.push(`• **${s.storeName}** — ${s.brand ?? "—"} • ${name}`);
    lines.push(`  ~~S/${reg}~~ → **S/${eff}** (${pct}% OFF) — ${s.canonicalUrl}`);
  }
}
const out = lines.join("\n");
process.stdout.write(out.length > 1900 ? out.slice(0, 1899) + "…" : out);
')
if [ -z "$MESSAGE" ]; then
  echo "[home-to-discord] mensaje vacío, abortando" >&2
  exit 1
fi

echo "[home-to-discord] enviando a Discord ($DISCORD_TARGET)..." >&2
hermes send --to "$DISCORD_TARGET" --quiet "$MESSAGE" \
  || echo "[home-to-discord] hermes send falló; el reporte queda en stdout arriba"
