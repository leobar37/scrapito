/**
 * Discovery registry — imported ONLY by the local `scrap discover` command.
 * Keeping it separate from `src/scrapers/registry.ts` ensures discovery-only
 * browser evaluation never reaches the server module graph.
 */
import type { Discovery } from "./define-discovery.ts";
import { ripleyDiscovery } from "./definitions/ripley-pe.ts";

const DISCOVERIES: readonly Discovery[] = [ripleyDiscovery];

export function getDiscovery(scraperId: string): Discovery | undefined {
  return DISCOVERIES.find((d) => d.scraperId === scraperId);
}

export function listDiscoveries(): readonly Discovery[] {
  return DISCOVERIES;
}

export { defineDiscovery } from "./define-discovery.ts";
export type {
  Discovery,
  DiscoverySpec,
  DiscoveryContext,
  DiscoveryArtifacts,
  DiscoveryFn,
} from "./define-discovery.ts";
export { FsDiscoveryArtifacts } from "./artifacts.ts";
