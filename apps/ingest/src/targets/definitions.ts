import {
  CapabilityDefinitionSchema,
  CapabilitySupportCellSchema,
  InvocationContextSchema,
  ScrapError,
  SiteDefinitionSchema,
  StrategyDefinitionSchema,
  type CapabilityDefinition,
  type CapabilityId,
  type CapabilitySupportCell,
  type InvocationContext,
  type SiteDefinition,
  type StoreId,
  type StrategyDefinition,
  type StrategyId,
  type TargetIdentityInput,
} from "@scrapito/contracts";
import type { RunOptions } from "../app/scrape-runner.ts";
import { resolvePages } from "../scrapers/pages.ts";
import { getScraper } from "../scrapers/registry.ts";

export const SITE_DEFINITIONS = Object.freeze([
  SiteDefinitionSchema.parse({
    site: "ripley-pe",
    scraperId: "ripley-pe-products",
    hosts: ["simple.ripley.com.pe"],
    canonicalization: { protocol: "https:", host: "simple.ripley.com.pe", stripHash: true },
    repairRoots: ["apps/ingest/src/scrapers/ripley-pe"],
    contextRefs: ["apps/ingest/src/scrapers/ripley-pe/products.ts", "apps/ingest/src/scrapers/ripley-pe/normalize.ts"],
  }),
  SiteDefinitionSchema.parse({
    site: "falabella-pe",
    scraperId: "falabella-pe-products",
    hosts: ["www.falabella.com.pe"],
    canonicalization: { protocol: "https:", host: "www.falabella.com.pe", stripHash: true },
    repairRoots: ["apps/ingest/src/scrapers/falabella-pe"],
    contextRefs: ["apps/ingest/src/scrapers/falabella-pe/products.ts", "apps/ingest/src/scrapers/falabella-pe/normalize.ts"],
  }),
  SiteDefinitionSchema.parse({
    site: "promart-pe",
    scraperId: "promart-pe-products",
    hosts: ["www.promart.pe"],
    canonicalization: { protocol: "https:", host: "www.promart.pe", stripHash: true },
    repairRoots: ["apps/ingest/src/scrapers/promart-pe"],
    contextRefs: ["apps/ingest/src/scrapers/promart-pe/products.ts", "apps/ingest/src/scrapers/promart-pe/normalize.ts"],
  }),
  SiteDefinitionSchema.parse({
    site: "oechsle-pe",
    scraperId: "oechsle-pe-products",
    hosts: ["www.oechsle.pe"],
    canonicalization: { protocol: "https:", host: "www.oechsle.pe", stripHash: true },
    repairRoots: ["apps/ingest/src/scrapers/oechsle-pe"],
    contextRefs: ["apps/ingest/src/scrapers/oechsle-pe/products.ts", "apps/ingest/src/scrapers/oechsle-pe/normalize.ts"],
  }),
] satisfies SiteDefinition[]);

export const STRATEGY_DEFINITIONS = Object.freeze([
  StrategyDefinitionSchema.parse({
    strategy: "homepage",
    targetKind: "homepage",
    coverage: { createsCoverage: false, authoritativeEligible: false, membershipEvidence: "none", boundary: "none" },
    contextRef: "strategy:homepage",
  }),
  StrategyDefinitionSchema.parse({
    strategy: "trending",
    targetKind: "trending",
    coverage: { createsCoverage: false, authoritativeEligible: false, membershipEvidence: "none", boundary: "none" },
    contextRef: "strategy:trending",
  }),
  StrategyDefinitionSchema.parse({
    strategy: "category",
    targetKind: "category",
    coverage: {
      createsCoverage: true,
      authoritativeEligible: false,
      membershipEvidence: "non_authoritative",
      boundary: "requested_pages",
    },
    contextRef: "strategy:category",
  }),
  StrategyDefinitionSchema.parse({
    strategy: "product",
    targetKind: "product",
    coverage: { createsCoverage: false, authoritativeEligible: false, membershipEvidence: "none", boundary: "none" },
    contextRef: "strategy:product",
  }),
  StrategyDefinitionSchema.parse({
    strategy: "search",
    targetKind: "search",
    coverage: { createsCoverage: false, authoritativeEligible: false, membershipEvidence: "none", boundary: "requested_pages" },
    contextRef: "strategy:search",
  }),
] satisfies StrategyDefinition[]);

export const CAPABILITY_DEFINITIONS = Object.freeze([
  CapabilityDefinitionSchema.parse({
    capability: "inspect",
    sideEffect: "none",
    output: "inspection",
    contextRef: "capability:inspect",
  }),
  CapabilityDefinitionSchema.parse({
    capability: "acquire",
    sideEffect: "catalog_write",
    output: "acquisition",
    contextRef: "capability:acquire",
  }),
  CapabilityDefinitionSchema.parse({
    capability: "repair",
    sideEffect: "worktree_write",
    output: "repair",
    contextRef: "capability:repair",
  }),
  CapabilityDefinitionSchema.parse({
    capability: "verify",
    sideEffect: "none",
    output: "verification",
    contextRef: "capability:verify",
  }),
] satisfies CapabilityDefinition[]);

const SUPPORTED_EVIDENCE = new Map<string, readonly string[]>([
  ["ripley-pe:category:acquire", ["ripley-pe/__fixtures__/list.html", "adapter:category"]],
  ["ripley-pe:search:acquire", ["ripley-pe/__fixtures__/list.html", "adapter:search"]],
  ["falabella-pe:category:acquire", ["falabella-pe/__fixtures__/list.html", "adapter:category"]],
  ["falabella-pe:search:acquire", ["falabella-pe/__fixtures__/list.html", "adapter:search"]],
  ["promart-pe:category:acquire", ["promart-pe/__fixtures__/search-refrigeracion.json", "adapter:category"]],
  ["promart-pe:search:acquire", ["promart-pe/__fixtures__/search-refrigeracion.json", "adapter:search"]],
  ["ripley-pe:category:repair", ["ripley-pe/__fixtures__/list.html", "adapter:category"]],
  ["ripley-pe:search:repair", ["ripley-pe/__fixtures__/list.html", "adapter:search"]],
  ["falabella-pe:category:repair", ["falabella-pe/__fixtures__/list.html", "adapter:category"]],
  ["falabella-pe:search:repair", ["falabella-pe/__fixtures__/list.html", "adapter:search"]],
  ["promart-pe:category:repair", ["promart-pe/__fixtures__/search-refrigeracion.json", "adapter:category"]],
  ["promart-pe:search:repair", ["promart-pe/__fixtures__/search-refrigeracion.json", "adapter:search"]],
  ["oechsle-pe:category:acquire", ["oechsle-pe/__fixtures__/search-televisores.json", "adapter:category"]],
  ["oechsle-pe:search:acquire", ["oechsle-pe/__fixtures__/search-televisores.json", "adapter:search"]],
  ["oechsle-pe:category:repair", ["oechsle-pe/__fixtures__/search-televisores.json", "adapter:category"]],
  ["oechsle-pe:search:repair", ["oechsle-pe/__fixtures__/search-televisores.json", "adapter:search"]],
]);

function unsupportedReason(strategy: StrategyId, capability: CapabilityId): string {
  if (strategy === "homepage" || strategy === "trending" || strategy === "product") {
    return "no checked-in fixture, typed adapter, and verified execution boundary";
  }
  if (capability === "inspect") return "no read-only inspection execution boundary is implemented";
  if (capability === "repair") return "repair execution and promotion gates are deferred to P-005";
  if (capability === "verify") return "independent verification execution is not implemented";
  return "unsupported by the registered scraper boundary";
}

const cells: CapabilitySupportCell[] = [];
for (const site of SITE_DEFINITIONS) {
  for (const strategy of STRATEGY_DEFINITIONS) {
    for (const capability of CAPABILITY_DEFINITIONS) {
      const key = `${site.site}:${strategy.strategy}:${capability.capability}`;
      const evidence = SUPPORTED_EVIDENCE.get(key);
      cells.push(
        CapabilitySupportCellSchema.parse(
          evidence
            ? { site: site.site, strategy: strategy.strategy, capability: capability.capability, supported: true, evidence }
            : {
                site: site.site,
                strategy: strategy.strategy,
                capability: capability.capability,
                supported: false,
                reason: unsupportedReason(strategy.strategy, capability.capability),
              },
        ),
      );
    }
  }
}
export const CAPABILITY_SUPPORT_MATRIX = Object.freeze(cells);

const SUPPORT_BY_KEY = new Map(
  CAPABILITY_SUPPORT_MATRIX.map((cell) => [`${cell.site}:${cell.strategy}:${cell.capability}`, cell] as const),
);
const SITE_BY_ID = new Map(SITE_DEFINITIONS.map((site) => [site.site, site] as const));

export function capabilitySupport(
  site: StoreId,
  strategy: StrategyId,
  capability: CapabilityId,
): CapabilitySupportCell {
  const cell = SUPPORT_BY_KEY.get(`${site}:${strategy}:${capability}`);
  if (!cell) throw new ScrapError("INVALID_CAPABILITY_MATRIX", `capability matrix cell missing: ${site}/${strategy}/${capability}`);
  return cell;
}

/** Pure fail-fast gate. It performs no registry lookup, network access, or write. */
export function assertInvocationSupported(raw: unknown): InvocationContext {
  const invocation = InvocationContextSchema.parse(raw);
  const cell = capabilitySupport(invocation.site, invocation.strategy, invocation.intent);
  if (!cell.supported) {
    throw new ScrapError(
      "UNSUPPORTED_INVOCATION",
      `unsupported invocation: ${invocation.site}/${invocation.strategy}/${invocation.intent}`,
      { reason: cell.reason },
    );
  }
  return invocation;
}

export interface AdaptedTargetInvocation {
  invocation: InvocationContext;
  site: SiteDefinition;
  scraperId: string;
  params: {
    category?: string;
    search?: string;
    pages?: InvocationContext["constraints"]["pages"];
    detail: false;
  };
  runOptions: RunOptions;
}

/** Converts only typed business targets to registered scraper params. No URL,
 * module path, command, or arbitrary scraper id can enter this adapter. */
export function adaptTargetInvocation(raw: unknown): AdaptedTargetInvocation {
  const invocation = assertInvocationSupported(raw);
  const site = SITE_BY_ID.get(invocation.site);
  if (!site) throw new ScrapError("UNKNOWN_SITE", `unknown site: ${invocation.site}`);

  const scraper = getScraper(site.scraperId);
  if (!scraper || scraper.store !== site.site) {
    throw new ScrapError("INVALID_SITE_DEFINITION", `site scraper is not statically registered: ${site.scraperId}`);
  }

  const pages = resolvePages(invocation.constraints.pages);
  const params =
    invocation.target.kind === "category"
      ? { category: invocation.target.externalId, pages: invocation.constraints.pages, detail: false as const }
      : invocation.target.kind === "search"
        ? { search: invocation.target.query, pages: invocation.constraints.pages, detail: false as const }
        : (() => {
            throw new ScrapError("INVALID_TARGET_ADAPTER", `no adapter for target kind: ${invocation.target.kind}`);
          })();
  const parsedParams = scraper.paramsSchema.parse(params) as AdaptedTargetInvocation["params"];
  const target: TargetIdentityInput | undefined =
    invocation.target.kind === "category" ? invocation.target : undefined;

  return {
    invocation,
    site,
    scraperId: site.scraperId,
    params: parsedParams,
    runOptions: {
      maxRequests: invocation.constraints.maxRequests ?? scraper.defaults.maxRequests,
      maxDurationMs: invocation.constraints.maxDurationMs ?? scraper.defaults.maxDurationMs,
      downloadImages: invocation.constraints.downloadImages ?? scraper.defaults.downloadImages,
      target,
      provenance: {
        invocationId: invocation.invocationId,
        strategy: invocation.strategy,
        capability: invocation.intent,
      },
      authoritativeCoverage: false,
      coverageBoundary:
        invocation.target.kind === "category"
          ? { kind: "requested_pages", pages }
          : undefined,
    },
  };
}
