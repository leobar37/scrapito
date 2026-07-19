import type { CapabilityDefinition, InvocationContext, SiteDefinition, StrategyDefinition } from "@scrapito/contracts";
import { basePrompt } from "./base.ts";
import { capabilityPrompt } from "./capability.ts";
import { sitePrompt } from "./site.ts";
import { strategyPrompt } from "./strategy.ts";

export function composePrompt(
  invocation: InvocationContext,
  site: SiteDefinition,
  strategy: StrategyDefinition,
  capability: CapabilityDefinition,
): string {
  return [
    "# Base",
    basePrompt(invocation),
    "# Site",
    sitePrompt(site),
    "# Strategy",
    strategyPrompt(strategy),
    "# Capability",
    capabilityPrompt(capability, invocation),
    "# Manifest",
    JSON.stringify(invocation),
  ].join("\n\n");
}
