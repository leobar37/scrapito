#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { startServer } from "./serve.ts";

const config = loadConfig();
const handle = startServer(config);
console.log(`scrapito api listening on http://${handle.hostname}:${handle.port}`);
