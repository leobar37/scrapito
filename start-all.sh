#!/usr/bin/env bash
# Supervisor for the three scrapito services. Restarts any that die.
# API :3000 (public), SSR :3002 (internal), proxy :3001 (public).
set -u
ROOT="/home/leobar37/code/scrap-many"
export SCRAP_DB_PATH="$ROOT/data/scrap.sqlite"
export SCRAP_STORAGE_DIR="$ROOT/storage"

start_api() {
  cd "$ROOT/apps/api" && \
  SCRAP_HOST=100.83.90.33 SCRAP_PUBLIC_READS=true WEB_ORIGIN=http://100.83.90.33:3001 \
    bun src/index.ts >> /tmp/scrapito-api.log 2>&1 &
  API_PID=$!
}
start_ssr() {
  cd "$ROOT/apps/web" && \
  PORT=3002 HOST=127.0.0.1 API_BASE_URL=http://100.83.90.33:3000 VITE_PUBLIC_API_BASE_URL=http://100.83.90.33:3000 \
    bun dist/server/server.js >> /tmp/scrapito-ssr.log 2>&1 &
  SSR_PID=$!
}
start_proxy() {
  cd "$ROOT/apps/web" && \
  PORT=3001 HOST=0.0.0.0 SSR_ORIGIN=http://127.0.0.1:3002 \
    bun serve-prod.ts >> /tmp/scrapito-web.log 2>&1 &
  PROXY_PID=$!
}

start_api; start_ssr; start_proxy
echo "supervisor up: api=$API_PID ssr=$SSR_PID proxy=$PROXY_PID"

while true; do
  sleep 5
  kill -0 "$API_PID" 2>/dev/null   || { echo "restarting api";   start_api; }
  kill -0 "$SSR_PID" 2>/dev/null   || { echo "restarting ssr";   start_ssr; }
  kill -0 "$PROXY_PID" 2>/dev/null || { echo "restarting proxy"; start_proxy; }
done
