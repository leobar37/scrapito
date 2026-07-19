/**
 * `scrap-ingest reports discord-top-deals` — pick the best verified_discount
 * offer per active store and post a Discord embed via webhook.
 *
 * Read-only against the catalog (no writer lease, no scraper run). Safe to run
 * concurrently with anything except `db:migrate`/`db:reset` while the SQLite
 * file is being rewritten.
 *
 * If `DISCORD_WEBHOOK_URL` is unset, the command runs in dry-run mode: it
 * prints the exact JSON payload that *would* be POSTed and exits 0. The
 * payload is always one valid Discord webhook body — `content` + `embeds[]` —
 * so a downstream cron job / agent can capture and forward it.
 */
import { openCatalogReader } from "@scrapito/catalog/read";
import type { StoreId } from "@scrapito/contracts";

export interface TopDealRow {
  storeId: StoreId;
  storeName: string;
  brand: string | null;
  name: string;
  regularCents: number;
  effectiveCents: number;
  discountBps: number;
  canonicalUrl: string;
  imageUrl: string | null;
}

export interface TopDealsReport {
  generatedAt: string;
  stores: TopDealRow[];
}

interface TopDealDbRow {
  storeId: string;
  storeName: string;
  brand: string | null;
  name: string;
  regularCents: number;
  effectiveCents: number;
  discountBps: number;
  canonicalUrl: string;
  imageUrl: string | null;
}

/** Pick one offer per store: highest `discount_bps` among verified_discount. */
export function buildTopDealsReport(dbPath: string): TopDealsReport {
  const reader = openCatalogReader(dbPath);
  try {
    const stores = reader.queries.listStores();
    const rows: TopDealRow[] = [];
    for (const s of stores) {
      const r = reader.db
        .query<TopDealDbRow, [string]>(
          `SELECT
              co.store_id        AS storeId,
              st.name            AS storeName,
              co.brand           AS brand,
              co.name            AS name,
              co.regular_cents   AS regularCents,
              co.effective_cents AS effectiveCents,
              co.discount_bps    AS discountBps,
              co.canonical_url   AS canonicalUrl,
              (SELECT '/images/' || pi.sha256
                 FROM product_images pi
                WHERE pi.product_id = co.product_id
                ORDER BY pi.position LIMIT 1) AS imageUrl
            FROM current_offers co
            JOIN stores st ON st.id = co.store_id
            WHERE co.store_id = ? AND co.quality = 'verified_discount'
            ORDER BY co.discount_bps DESC
            LIMIT 1`,
        )
        .get(s.id);
      if (r) rows.push(r as TopDealRow);
    }
    return { generatedAt: new Date().toISOString(), stores: rows };
  } finally {
    reader.close();
  }
}

/** Compose the Discord webhook body. Stable shape so downstream consumers can
 *  replay / log / archive it. */
export function buildDiscordPayload(
  report: TopDealsReport,
  apiBaseUrl: (path: string) => string,
): unknown {
  const lines: string[] = [];
  for (const s of report.stores) {
    const pct = Math.round(s.discountBps / 100);
    const offer = (s.effectiveCents / 100).toFixed(2);
    const regular = (s.regularCents / 100).toFixed(2);
    lines.push(
      `**${s.storeName}** — ${s.brand ?? "—"} • ${truncate(s.name, 120)}\n` +
        `~~S/${regular}~~ → **S/${offer}** (${pct}% OFF) — ${s.canonicalUrl}`,
    );
  }
  const embeds = report.stores.map((s) => ({
    title: truncate(`${s.brand ?? ""} ${s.name}`.trim(), 240),
    url: s.canonicalUrl,
    color: 0xff5a1f,
    fields: [
      { name: "Tienda", value: s.storeName, inline: true },
      { name: "Regular", value: `S/${(s.regularCents / 100).toFixed(2)}`, inline: true },
      { name: "Oferta", value: `S/${(s.effectiveCents / 100).toFixed(2)}`, inline: true },
      { name: "Descuento", value: `${Math.round(s.discountBps / 100)}%`, inline: true },
    ],
    ...(s.imageUrl ? { image: { url: apiBaseUrl(s.imageUrl) } } : {}),
    timestamp: report.generatedAt,
  }));
  return {
    content: lines.length > 0 ? lines.join("\n") : "Sin ofertas verificadas en este momento.",
    embeds,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** POST a Discord webhook. Throws on non-2xx. Returns the response body. */
export async function postDiscordWebhook(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`discord webhook ${res.status}: ${body.slice(0, 200)}`);
  }
  return { status: res.status, body };
}
