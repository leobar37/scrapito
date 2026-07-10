#!/usr/bin/env bun
/**
 * `scrap` operator CLI. Manages migrations, discovery, scraper validation, runs,
 * jobs, images, search, export, and the HTTP server over the shared services.
 * `discover` never executes or promotes generated source; `scrapers validate`
 * runs offline (no network, no agent-browser).
 */
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { openDatabase, runMigrations } from "../persistence/db.ts";
import { rmSync } from "node:fs";
import { createApp, createScraping } from "../app/services.ts";
import { getScraper, listScrapers } from "../scrapers/registry.ts";
import { ProductInputSchema, type Pages } from "../domain/schemas.ts";
import { startServer } from "../server/serve.ts";

function parsePages(value: string | undefined): Pages | undefined {
  if (!value) return undefined;
  const range = value.match(/^(\d+)-(\d+)$/);
  if (range && range[1] && range[2]) {
    return { from: Number(range[1]), to: Number(range[2]) };
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const program = new Command();
program.name("scrap").description("Peru-only scraping platform CLI");

// ---- db ----
const db = program.command("db").description("database management");
db.command("migrate")
  .description("apply pending migrations (idempotent)")
  .action(() => {
    const config = loadConfig();
    const database = openDatabase(config.dbPath);
    const result = runMigrations(database);
    console.log(JSON.stringify({ applied: result.applied, alreadyApplied: result.alreadyApplied }));
    database.close();
  });
db.command("reset")
  .description("DROP and recreate the database")
  .option("--yes", "confirm destructive reset")
  .action((opts: { yes?: boolean }) => {
    if (!opts.yes) {
      console.error("refusing to reset without --yes");
      process.exit(1);
    }
    const config = loadConfig();
    try {
      rmSync(config.dbPath, { force: true });
      rmSync(config.dbPath + "-wal", { force: true });
      rmSync(config.dbPath + "-shm", { force: true });
    } catch {
      /* ignore */
    }
    const database = openDatabase(config.dbPath);
    runMigrations(database);
    database.close();
    console.log("database reset");
  });

// ---- browser ----
const browser = program.command("browser").description("agent-browser management");
browser.command("install").action(async () => {
  await runBrowserCli(["install"]);
});
browser.command("doctor").action(async () => {
  await runBrowserCli(["doctor", "--json"]);
});

async function runBrowserCli(args: string[]): Promise<void> {
  const config = loadConfig();
  const proc = Bun.spawn([config.agentBrowserBin, ...args], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

// ---- stores ----
program
  .command("stores")
  .command("list")
  .description("list configured stores")
  .action(() => {
    const app = createApp(loadConfig(), { requireMigrated: false });
    console.log(JSON.stringify(app.persistence.queries.listStores(), null, 2));
    app.close();
  });

// ---- scrapers ----
const scrapers = program.command("scrapers").description("registered scrapers");
scrapers
  .command("list")
  .action(() => {
    console.log(
      JSON.stringify(
        listScrapers().map((s) => ({ id: s.id, store: s.store, version: s.version })),
        null,
        2,
      ),
    );
  });
scrapers
  .command("validate <fileOrId>")
  .description("offline static + fixture validation (no network, no browser)")
  .action((fileOrId: string) => {
    const scraper = getScraper(fileOrId);
    if (!scraper) {
      console.error(`unknown scraper id: ${fileOrId}`);
      process.exit(1);
    }
    if (!scraper.selfCheck) {
      console.error(`scraper ${fileOrId} has no selfCheck fixtures`);
      process.exit(1);
    }
    const products = scraper.selfCheck();
    let valid = 0;
    const errors: string[] = [];
    for (const p of products) {
      const r = ProductInputSchema.safeParse(p);
      if (r.success) valid++;
      else errors.push(r.error.issues[0]?.message ?? "invalid");
    }
    if (errors.length > 0) {
      console.error(JSON.stringify({ ok: false, valid, errors }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, scraper: scraper.id, products: products.length, valid }));
  });

// ---- scrape ----
program
  .command("scrape <scraperId>")
  .option("--category <value>")
  .option("--search <term>", "keyword search (e.g. juguetes)")
  .option("--pages <n|a-b>")
  .option("--max-requests <n>", "max requests", (v) => Number(v))
  .option("--max-duration <ms>", "max duration ms", (v) => Number(v))
  .option("--no-images", "skip image downloads")
  .option("--dry-run", "validate params and plan without running")
  .action(async (scraperId: string, opts: Record<string, unknown>) => {
    const scraper = getScraper(scraperId);
    if (!scraper) {
      console.error(`unknown scraper id: ${scraperId}`);
      process.exit(1);
    }
    const params = {
      category: opts.category as string | undefined,
      search: opts.search as string | undefined,
      pages: parsePages(opts.pages as string | undefined),
    };
    const parsed = scraper.paramsSchema.safeParse(params);
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.issues, null, 2));
      process.exit(1);
    }
    if (opts.dryRun) {
      console.log(JSON.stringify({ dryRun: true, scraper: scraperId, params }));
      return;
    }
    const app = createApp(loadConfig());
    const scraping = createScraping(app);
    const outcome = await scraping.runner.run(scraper, params, {
      maxRequests: (opts.maxRequests as number | undefined) ?? scraper.defaults.maxRequests,
      maxDurationMs: (opts.maxDuration as number | undefined) ?? scraper.defaults.maxDurationMs,
      downloadImages: opts.images !== false,
    });
    console.log(JSON.stringify(outcome, null, 2));
    app.close();
  });

// ---- jobs ----
const jobs = program.command("jobs").description("job queue");
jobs.command("list").action(() => {
  const app = createApp(loadConfig(), { requireMigrated: false });
  console.log(JSON.stringify(app.persistence.queries.listJobs({ limit: 100 }), null, 2));
  app.close();
});
jobs.command("show <id>").action((id: string) => {
  const app = createApp(loadConfig(), { requireMigrated: false });
  console.log(JSON.stringify(app.persistence.queries.getJob(Number(id)), null, 2));
  app.close();
});
jobs.command("retry <id>").action((id: string) => {
  const app = createApp(loadConfig(), { requireMigrated: false });
  const ok = app.persistence.jobs.retry(Number(id));
  console.log(JSON.stringify({ retried: ok }));
  app.close();
});
jobs.command("cancel <id>").action((id: string) => {
  const app = createApp(loadConfig(), { requireMigrated: false });
  const ok = app.persistence.jobs.cancel(Number(id));
  console.log(JSON.stringify({ cancelled: ok }));
  app.close();
});

// ---- images ----
const images = program.command("images").description("image pipeline");
images.command("sync").action(async () => {
  const app = createApp(loadConfig());
  const scraping = createScraping(app);
  const result = await scraping.images.processPending(500);
  console.log(JSON.stringify(result));
  app.close();
});
images.command("stats").action(() => {
  const app = createApp(loadConfig(), { requireMigrated: false });
  console.log(JSON.stringify(app.persistence.queries.stats()));
  app.close();
});

// ---- stats / search ----
program.command("stats").action(() => {
  const app = createApp(loadConfig(), { requireMigrated: false });
  console.log(JSON.stringify(app.persistence.queries.stats(), null, 2));
  app.close();
});
program
  .command("search <query>")
  .action((query: string) => {
    const app = createApp(loadConfig(), { requireMigrated: false });
    console.log(JSON.stringify(app.persistence.queries.search(query, { limit: 50 }), null, 2));
    app.close();
  });

// ---- serve ----
program
  .command("serve")
  .option("--host <host>")
  .option("--port <port>", "port", (v) => Number(v))
  .action(async (opts: { host?: string; port?: number }) => {
    const app = createApp(loadConfig());
    const handle = startServer(app, { host: opts.host, port: opts.port });
    console.log(`listening on http://${handle.hostname}:${handle.port}`);
    // Keep alive; run the job worker loop alongside if a user agent is configured.
    if (app.config.userAgent) {
      const scraping = createScraping(app);
      scraping.worker.recover();
      void scraping.worker.loop(1000);
    }
    // Run forever until the process is signalled.
    const { promise } = Promise.withResolvers<void>();
    await promise;
  });

program.parseAsync(process.argv);
