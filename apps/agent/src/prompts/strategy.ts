import type { StrategyDefinition } from "@scrapito/contracts";

export function strategyPrompt(strategy: StrategyDefinition): string {
  const coverage = strategy.coverage;
  return [
    `Strategy: ${strategy.strategy} (target kind ${strategy.targetKind})`,
    `Strategy context: ${strategy.contextRef}`,
    `Coverage: creates=${coverage.createsCoverage}, authoritativeEligible=${coverage.authoritativeEligible}, membership=${coverage.membershipEvidence}, boundary=${coverage.boundary}`,
    "Do not infer coverage beyond this declared boundary.",
  ].join("\n");
}
