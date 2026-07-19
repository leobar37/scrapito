import type { SiteDefinition } from "@scrapito/contracts";

export function sitePrompt(site: SiteDefinition): string {
  return [
    `Site: ${site.site}`,
    `Registered scraper: ${site.scraperId}`,
    `Allowed hosts: ${site.hosts.join(", ")}`,
    `Canonical host: ${site.canonicalization.host}`,
    `Evidence context refs: ${site.contextRefs.join(", ")}`,
    `Repair roots (host policy only): ${site.repairRoots.join(", ")}`,
  ].join("\n");
}
